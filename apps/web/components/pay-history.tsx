"use client";
import { useState } from "react";
import { api, fmtDate, money } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox } from "./ui";

type Rate = { id: string | null; effectiveDate: string; payType: string; payRateCents: number; note: string | null; createdBy: string | null; current: boolean; upcoming: boolean };

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const pay = (r: { payType: string; payRateCents: number }) => `${money(r.payRateCents)}${r.payType === "hourly" ? "/hr" : "/yr salary"}`;

/**
 * Employee page: pay history (managers) and adding a raise from a date (admins). Payroll pays each
 * day at the rate in effect that day, so earlier periods keep the old rate.
 */
export function PayHistoryBox({ employeeId, firstName, onChange }: { employeeId: string; firstName: string; onChange: () => void }) {
  const { can } = useAuth();
  const admin = can("admin", "people");
  const rates = useApi<Rate[]>(`/employees/${employeeId}/pay-rates`);
  const [adding, setAdding] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const current = rates.data?.find((r) => r.current);

  const done = (res: { warning: string | null }) => { setWarning(res.warning); rates.reload(); onChange(); };

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Pay History</h2>
        {admin && <button className="btn primary sm" onClick={() => { setAdding(!adding); setWarning(null); }}>{adding ? "Cancel" : "Add a raise or pay change"}</button>}
      </div>
      {adding && (
        <form className="stack" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          run(async () => {
            const res = await api(`/employees/${employeeId}/pay-rates`, { body: {
              effectiveDate: f.get("effectiveDate"),
              payType: f.get("payType"),
              payRateCents: Math.round(Number(f.get("rate")) * 100),
              note: (f.get("note") as string) || undefined,
            } });
            setAdding(false);
            done(res);
          });
        }}>
          <div className="formgrid">
            <label>Starts on<input name="effectiveDate" type="date" required defaultValue={today()} /></label>
            <label>Pay type
              <select name="payType" defaultValue={current?.payType ?? "hourly"}>
                <option value="hourly">Hourly</option>
                <option value="salary">Salary</option>
              </select>
            </label>
            <label>New rate ($/hr or $/yr)<input name="rate" type="number" step="0.01" min="0" required defaultValue={current ? current.payRateCents / 100 : ""} /></label>
            <label>Note<input name="note" maxLength={200} placeholder="e.g. Annual raise" /></label>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Payroll uses the new rate from this date on; earlier days keep the old rate. A date in the future takes effect on that day.
            The same date as an existing entry replaces it.
          </p>
          <ErrorBox error={error} />
          <div><button className="btn primary" disabled={busy}>Save pay change</button></div>
        </form>
      )}
      {warning && <p className="muted" role="status" style={{ margin: 0 }}>⚠ {warning}</p>}
      {rates.data?.length ? (
        <table>
          <thead><tr><th>Starts</th><th>Pay</th><th>Note</th><th>Entered by</th><th /></tr></thead>
          <tbody>{rates.data.map((r) => (
            <tr key={r.id ?? r.effectiveDate}>
              {/* The first rate covers everything before the next one; with no hire date it's stored as 2000-01-01. */}
              <td>{r.effectiveDate <= "2000-01-01" ? "From the start" : fmtDate(r.effectiveDate)}</td>
              <td>
                <strong>{pay(r)}</strong>
                {r.current && <span className="badge ok" style={{ marginLeft: 6 }}>current</span>}
                {r.upcoming && <span className="badge warn" style={{ marginLeft: 6 }}>upcoming</span>}
              </td>
              <td className="muted">{r.note ?? ""}</td>
              <td className="muted">{r.createdBy ?? "—"}</td>
              <td>
                {admin && r.id && rates.data!.filter((x) => x.id).length > 1 && (
                  <button className="btn sm danger" disabled={busy} onClick={() => confirm(`Remove the ${pay(r)} entry starting ${fmtDate(r.effectiveDate)}? Only do this for a mistake.`) && run(async () => done(await api(`/employees/${employeeId}/pay-rates/${r.id}`, { method: "DELETE" })))}>Remove</button>
                )}
              </td>
            </tr>
          ))}</tbody>
        </table>
      ) : rates.data ? <Empty>No pay recorded for {firstName}.</Empty> : <ErrorBox error={rates.error} />}
    </div>
  );
}

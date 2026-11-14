"use client";
import { useState } from "react";
import { api, fmtDate } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Badge, Empty, ErrorBox } from "./ui";

/**
 * Employee page: request time off for this person (yourself, or, for managers and up, someone
 * else) and see their recent requests. `balances` are this person's, to show what's available.
 */
export function RequestTimeOffBox({ employeeId, firstName, isSelf, balances, onChange }: {
  employeeId: string; firstName: string; isSelf: boolean; balances: any[] | null; onChange: () => void;
}) {
  const policies = useApi<any[]>("/pto/policies");
  const requests = useApi<any[]>(isSelf ? "/pto/requests?mine=true" : `/pto/requests?employeeId=${employeeId}`);
  const [policyId, setPolicyId] = useState("");
  const { busy, error, run } = useAction();
  const [sent, setSent] = useState(false);
  const chosen = policyId || policies.data?.[0]?.id || "";
  const bal = balances?.find((b) => b.policyId === chosen);
  const available = bal ? Math.round((bal.balanceHours - bal.pendingHours) * 100) / 100 : null;
  const recent = (requests.data ?? []).slice(0, 5);

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Request Time Off</h2>
      {!isSelf && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Entered for {firstName}. It goes through the usual approval, and {firstName} is told.</p>}
      <form className="stack" onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        run(async () => {
          await api("/pto/requests", { body: {
            policyId: chosen,
            startDate: f.get("startDate"),
            endDate: f.get("endDate"),
            hours: Number(f.get("hours")),
            reason: (f.get("reason") as string) || undefined,
            ...(isSelf ? {} : { employeeId }),
          } });
          form.reset();
          setSent(true);
          requests.reload();
          onChange();
        });
      }} onChange={() => setSent(false)}>
        <div className="formgrid">
          <label>Start<input type="date" name="startDate" required /></label>
          <label>End<input type="date" name="endDate" required /></label>
          <label>Type
            <select value={chosen} onChange={(e) => setPolicyId(e.target.value)} required>
              {policies.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {available != null && <span className="muted" style={{ fontSize: 12 }}>{available}h available</span>}
          </label>
          <label>Hours<input type="number" name="hours" step="0.5" min="0.5" required /></label>
        </div>
        <label>Reason (optional)<input name="reason" maxLength={500} /></label>
        <ErrorBox error={error} />
        <div className="row">
          <button className="btn primary" disabled={busy || !chosen}>Submit request</button>
          {sent && <span className="muted" role="status">Sent for approval.</span>}
        </div>
      </form>
      <div>
        <strong style={{ fontSize: 14 }}>Recent Requests</strong>
        {recent.length ? (
          <table><tbody>{recent.map(({ request: r, policyName }) => (
            <tr key={r.id}>
              <td>{policyName}<div className="muted" style={{ fontSize: 12 }}>{r.reason}</div></td>
              <td>{fmtDate(r.startDate)}{r.endDate !== r.startDate ? ` – ${fmtDate(r.endDate)}` : ""}</td>
              <td>{r.hours}h</td>
              <td><Badge value={r.status} /></td>
            </tr>
          ))}</tbody></table>
        ) : requests.data ? <Empty>No requests yet.</Empty> : null}
      </div>
    </div>
  );
}

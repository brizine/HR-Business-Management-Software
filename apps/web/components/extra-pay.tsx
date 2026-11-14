"use client";
import { useMemo, useState } from "react";
import { EXTRA_PAY_KINDS, EXTRA_PAY_LABELS, isInactive, type ExtraPayKind } from "@crewdesk/shared";
import { api, fmtDate, money } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox } from "./ui";

type Item = { id: string; employeeId: string; employeeName: string | null; date: string; kind: ExtraPayKind; amountCents: number; note: string | null; createdBy: string | null };

const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** A line's extra pay, under its estimated gross: "+ $250.00 bonus". */
export function ExtraPayLines({ line }: { line: { extraPay?: { id: string; kind: string; amountCents: number; note: string | null }[] } }) {
  if (!line.extraPay?.length) return null;
  return (
    <>
      {line.extraPay.map((x) => (
        <div key={x.id} className="muted" style={{ fontSize: 12, maxWidth: 240 }} title={x.note ?? undefined}>
          {x.kind === "reimbursement" ? "Reimbursement (not wages)" : "+"} {money(x.amountCents)} {x.kind === "reimbursement" ? "" : EXTRA_PAY_LABELS[x.kind as ExtraPayKind].toLowerCase()}{x.note ? `: ${x.note}` : ""}
        </div>
      ))}
    </>
  );
}

/** Add a bonus, commission, reimbursement or other pay, for one person or several. */
function ExtraPayForm({ employeeId, defaultDate, onAdded, onCancel }: { employeeId?: string; defaultDate: string; onAdded: (warning: string | null) => void; onCancel: () => void }) {
  const staff = useApi<any[]>(employeeId ? null : "/employees");
  const [picked, setPicked] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const { busy, error, run } = useAction();
  const people = useMemo(() => (staff.data ?? []).filter((e) => !isInactive(e.status)).sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`)), [staff.data]);
  const shown = people.filter((e) => !q || `${e.firstName} ${e.lastName} ${e.title ?? ""} ${e.department ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <form className="stack" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      run(async () => {
        const ids = employeeId ? [employeeId] : picked;
        if (!ids.length) throw new Error("Choose who it's for");
        const res = await api<{ warning: string | null }>("/extra-pay", { body: {
          employeeIds: ids,
          date: f.get("date"),
          kind: f.get("kind"),
          amountCents: Math.round(Number(f.get("amount")) * 100),
          note: (f.get("note") as string) || undefined,
        } });
        onAdded(res.warning);
      });
    }}>
      <div className="formgrid">
        <label>Type
          <select name="kind" defaultValue="bonus">
            {EXTRA_PAY_KINDS.map((k) => <option key={k} value={k}>{EXTRA_PAY_LABELS[k]}</option>)}
          </select>
        </label>
        <label>Amount ($){employeeId ? "" : " each"}<input name="amount" type="number" min="0.01" step="0.01" required /></label>
        <label>Date<input name="date" type="date" required defaultValue={defaultDate} /></label>
        <label>Note<input name="note" maxLength={300} placeholder="e.g. Holiday bonus, fuel receipt" /></label>
      </div>
      {!employeeId && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
            <label style={{ width: 240 }}>Who<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, title, department…" /></label>
            <button type="button" className="btn sm" onClick={() => setPicked([...new Set([...picked, ...shown.map((e) => e.id)])])}>Select all shown</button>
            <button type="button" className="btn sm" onClick={() => setPicked([])}>Clear</button>
            <span className="muted" style={{ fontSize: 13 }}>{picked.length} selected</span>
          </div>
          <div className="extra-pay-people">
            {shown.map((e) => (
              <label key={e.id} className="check"><input type="checkbox" checked={picked.includes(e.id)} onChange={() => toggle(e.id)} /> {e.firstName} {e.lastName}{e.title ? <span className="muted"> · {e.title}</span> : null}</label>
            ))}
          </div>
        </div>
      )}
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        It goes in the pay period its date falls in. Bonuses, commissions and other pay are added to the estimated gross; reimbursements are listed
        separately because they aren&apos;t wages.
      </p>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy}>{employeeId || picked.length <= 1 ? "Add extra pay" : `Add for ${picked.length} people`}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * Extra pay list with add/remove. On the employee page pass `employeeId`; on the Payroll page
 * pass the period's dates to list everyone's extra pay in it.
 */
export function ExtraPayBox({ employeeId, from, to, title = "Extra Pay", onChange }: { employeeId?: string; from?: string; to?: string; title?: string; onChange?: () => void }) {
  const { can } = useAuth();
  const admin = can("admin", "payroll");
  const qs = new URLSearchParams({ ...(employeeId ? { employeeId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
  const list = useApi<Item[]>(`/extra-pay?${qs}`);
  const [adding, setAdding] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const remove = useAction();
  const changed = (w: string | null) => { setWarning(w); list.reload(); onChange?.(); };
  // Today, unless the page is showing a pay period that doesn't include today: then its last day.
  const today = todayYmd();
  const defaultDate = from && to && (today < from || today > to) ? to : today;

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        {admin && <button className="btn primary sm" onClick={() => { setAdding(!adding); setWarning(null); }}>{adding ? "Cancel" : "Add extra pay"}</button>}
      </div>
      {!employeeId && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Bonuses, commissions, reimbursements and other pay for this pay period. Add it for one person or a whole crew at once.</p>}
      {adding && <ExtraPayForm employeeId={employeeId} defaultDate={defaultDate} onCancel={() => setAdding(false)} onAdded={(w) => { setAdding(false); changed(w); }} />}
      {warning && <p role="status" style={{ margin: 0 }}>⚠ {warning}</p>}
      <ErrorBox error={remove.error || list.error} />
      {list.data?.length ? (
        <table>
          <thead><tr><th>Date</th>{!employeeId && <th>Employee</th>}<th>Type</th><th>Amount</th><th>Note</th><th>Added by</th><th /></tr></thead>
          <tbody>{list.data.map((x) => (
            <tr key={x.id}>
              <td>{fmtDate(x.date)}</td>
              {!employeeId && <td>{x.employeeName ?? "—"}</td>}
              <td>{EXTRA_PAY_LABELS[x.kind] ?? x.kind}</td>
              <td><strong>{money(x.amountCents)}</strong></td>
              <td className="muted">{x.note ?? ""}</td>
              <td className="muted">{x.createdBy ?? "—"}</td>
              <td>{admin && <button className="btn sm danger" disabled={remove.busy} onClick={() => confirm(`Remove this ${EXTRA_PAY_LABELS[x.kind].toLowerCase()} of ${money(x.amountCents)}?`) && remove.run(async () => changed((await api<{ warning: string | null }>(`/extra-pay/${x.id}`, { method: "DELETE" })).warning))}>Remove</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : list.data ? <Empty>{employeeId ? "No extra pay yet." : "No extra pay in this period."}</Empty> : null}
    </div>
  );
}

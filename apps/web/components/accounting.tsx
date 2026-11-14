"use client";
import { useEffect, useState } from "react";
import { EXPENSE_ACCOUNT_TYPES, LIABILITY_ACCOUNT_TYPES, PAYMENT_ACCOUNT_TYPES, type AccountingSettings } from "@crewdesk/shared";
import { api, fmtDate, money } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox } from "./ui";

type Account = { id: number; name: string; code: string | null; type: string };
type Posting = { status: "posted" | "failed"; externalId: string | null; amountCents: number; error: string | null; updatedAt: string } | null;
type Status = {
  connected: boolean;
  baseUrl: string | null;
  payroll: { id: string; periodStart: string; periodEnd: string; payday: string; posting: Posting; changedSincePosting: boolean }[];
  workOrders: { id: string; number: number; title: string; assetName: string; completedAt: string; totalCents: number; posting: Posting; changedSincePosting: boolean }[];
};

/** Posted / failed / not sent, with a Send (or Try again) button. */
function SyncCell({ posting, changed, onSend, busy }: { posting: Posting; changed: boolean; onSend: () => void; busy: boolean }) {
  if (posting?.status === "posted") {
    return (
      <span>
        <span className="badge ok">sent</span>{posting.externalId && <span className="muted" style={{ fontSize: 12 }}> #{posting.externalId}</span>}
        {changed && <div className="muted" style={{ fontSize: 12, color: "var(--warn)" }}>Changed since it was sent: adjust it in Bigcapital</div>}
      </span>
    );
  }
  return (
    <span className="row" style={{ gap: 6, flexWrap: "nowrap", justifyContent: "flex-end" }}>
      {posting?.status === "failed" && <span className="badge bad" title={posting.error ?? ""}>failed</span>}
      <button className="btn sm" disabled={busy} onClick={onSend}>{posting?.status === "failed" ? "Try again" : "Send"}</button>
    </span>
  );
}

/** Payroll page: connect Bigcapital, choose accounts, and see what's been sent. */
export function AccountingCard() {
  const { can } = useAuth();
  const owner = can("owner", "payroll");
  const saved = useApi<AccountingSettings & { hasKey: boolean }>("/accounting/settings");
  const status = useApi<Status>("/accounting/status");
  const [s, setS] = useState<(AccountingSettings & { hasKey: boolean }) | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const action = useAction();
  const send = useAction();
  useEffect(() => { if (saved.data) { setS(saved.data); setEditing(!saved.data.enabled); } }, [saved.data]);
  // Once connected, load the account list for the dropdowns.
  useEffect(() => {
    if (saved.data?.enabled && saved.data.hasKey && !accounts) api<Account[]>("/accounting/accounts").then(setAccounts, () => {});
  }, [saved.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <div className="card"><h2>Accounting</h2><ErrorBox error={saved.error} /></div>;
  const set = (p: Partial<typeof s>) => { setS({ ...s, ...p }); setNote(null); };
  const pickAccount = (label: string, key: keyof AccountingSettings, types: string[], hint: string, optional = false) => (
    <label>{label}
      <select value={(s[key] as number | null) ?? ""} onChange={(e) => set({ [key]: e.target.value ? Number(e.target.value) : null } as Partial<typeof s>)} disabled={!accounts}>
        <option value="">{optional ? "Same as above" : accounts ? "Choose…" : "Test the connection first"}</option>
        {(accounts ?? []).filter((a) => types.includes(a.type)).map((a) => <option key={a.id} value={a.id}>{a.code ? `${a.code} · ` : ""}{a.name}</option>)}
      </select>
      <span className="muted" style={{ fontSize: 12 }}>{hint}</span>
    </label>
  );
  const sendIt = (path: string) => send.run(async () => { try { await api(path, { method: "POST" }); } finally { status.reload(); } });
  const st = status.data;

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0 }}>Accounting (Bigcapital)</h2>
          <p className="muted" style={{ margin: "4px 0 0" }}>Send approved payroll and work order costs to your books, so nobody types them in twice.</p>
        </div>
        {st?.connected && st.baseUrl && <a className="btn" href={st.baseUrl} target="_blank" rel="noopener noreferrer">Open Bigcapital ↗</a>}
      </div>

      {editing || !s.enabled ? (
        <form className="stack" onSubmit={(e) => {
          e.preventDefault();
          action.run(async () => {
            const r = await api<typeof s>("/accounting/settings", { method: "PUT", body: { ...s, enabled: true, apiKey: apiKey || undefined } });
            saved.setData(r);
            setApiKey("");
            setEditing(false);
            setNote("Saved.");
            status.reload();
          });
        }}>
          <fieldset disabled={!owner} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="formgrid">
              <label>Bigcapital address<input type="url" required value={s.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://books.example.com" /></label>
              <label>API key
                <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={s.hasKey ? "Saved (leave blank to keep it)" : "bc_…"} />
                <span className="muted" style={{ fontSize: 12 }}>In Bigcapital: Preferences → API keys → Generate. Stored encrypted; never shown again.</span>
              </label>
            </div>
            <div className="row">
              <button type="button" className="btn" disabled={action.busy || !s.baseUrl || (!apiKey && !s.hasKey)} onClick={() => action.run(async () => {
                const r = await api<{ accounts: Account[] }>("/accounting/test", { body: { baseUrl: s.baseUrl, apiKey: apiKey || undefined } });
                setAccounts(r.accounts);
                setNote(`Connected: found ${r.accounts.length} accounts. Choose where things go below.`);
              })}>Test connection</button>
              {note && <span className="muted" role="status">{note}</span>}
            </div>
            <h3 style={{ margin: "8px 0 0" }}>Payroll</h3>
            <div className="formgrid">
              {pickAccount("Wages expense", "wagesAccountId", EXPENSE_ACCOUNT_TYPES, "Debited with each period's estimated gross wages.")}
              {pickAccount("Time off & holidays expense", "timeOffAccountId", EXPENSE_ACCOUNT_TYPES, "Optional: paid time off and holidays on their own line.", true)}
              {pickAccount("Payroll liability", "payrollLiabilityAccountId", LIABILITY_ACCOUNT_TYPES, "Credited, e.g. Payroll Liabilities / Wages Payable. Clear it when you pay.")}
            </div>
            <label className="check"><input type="checkbox" checked={s.autoPostPayroll} onChange={(e) => set({ autoPostPayroll: e.target.checked })} /> Send each pay period automatically when it&apos;s approved</label>
            <h3 style={{ margin: "8px 0 0" }}>Work Orders</h3>
            <div className="formgrid">
              {pickAccount("Parts expense", "partsAccountId", EXPENSE_ACCOUNT_TYPES, "e.g. Vehicle Repairs & Maintenance.")}
              {pickAccount("Labor expense", "laborAccountId", EXPENSE_ACCOUNT_TYPES, "Optional: shop labor on its own account.", true)}
              {pickAccount("Paid from", "workOrderPaymentAccountId", PAYMENT_ACCOUNT_TYPES, "Bank, cash or credit card account.")}
            </div>
            <label className="check"><input type="checkbox" checked={s.autoPostWorkOrders} onChange={(e) => set({ autoPostWorkOrders: e.target.checked })} /> Send each work order&apos;s costs automatically when it&apos;s completed</label>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Payroll is posted as estimated gross wages for hourly staff (before taxes and deductions). Record taxes and the actual payment in Bigcapital, or from your payroll provider.
            </p>
          </fieldset>
          <ErrorBox error={action.error} />
          {owner ? (
            <div className="row">
              <button className="btn primary" disabled={action.busy}>Save</button>
              {s.enabled && <button type="button" className="btn" onClick={() => { setS(saved.data!); setEditing(false); }}>Cancel</button>}
            </div>
          ) : <p className="muted" style={{ margin: 0 }}>Only the owner can connect Bigcapital.</p>}
        </form>
      ) : (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span><span className="badge ok">connected</span> <span className="muted">{s.baseUrl}{s.autoPostPayroll || s.autoPostWorkOrders ? ` · sends ${[s.autoPostPayroll ? "payroll" : null, s.autoPostWorkOrders ? "work orders" : null].filter(Boolean).join(" and ")} automatically` : " · sending by hand"}</span></span>
          {owner && <button className="btn sm" onClick={() => setEditing(true)}>Change settings</button>}
        </div>
      )}

      {st?.connected && (
        <>
          <ErrorBox error={send.error} />
          <h3 style={{ margin: "8px 0 0" }}>Approved Pay Periods</h3>
          {st.payroll.length ? (
            <table><tbody>{st.payroll.map((p) => (
              <tr key={p.id}>
                <td>{fmtDate(p.periodStart)} – {fmtDate(p.periodEnd)}<div className="muted" style={{ fontSize: 12 }}>Payday {fmtDate(p.payday)}</div></td>
                <td>{p.posting?.amountCents ? money(p.posting.amountCents) : ""}{p.posting?.status === "failed" && <div className="muted" style={{ fontSize: 12, color: "var(--bad)" }}>{p.posting.error}</div>}</td>
                <td style={{ textAlign: "right" }}><SyncCell posting={p.posting} changed={p.changedSincePosting} busy={send.busy} onSend={() => sendIt(`/accounting/payroll/${p.id}`)} /></td>
              </tr>
            ))}</tbody></table>
          ) : <Empty>No approved pay periods yet.</Empty>}
          <h3 style={{ margin: "8px 0 0" }}>Completed Work Orders with Costs</h3>
          {st.workOrders.length ? (
            <table><tbody>{st.workOrders.map((w) => (
              <tr key={w.id}>
                <td>#{w.number} {w.title}<div className="muted" style={{ fontSize: 12 }}>{w.assetName} · {fmtDate(w.completedAt)}</div></td>
                <td>{money(w.totalCents)}{w.posting?.status === "failed" && <div className="muted" style={{ fontSize: 12, color: "var(--bad)" }}>{w.posting.error}</div>}</td>
                <td style={{ textAlign: "right" }}><SyncCell posting={w.posting} changed={w.changedSincePosting} busy={send.busy} onSend={() => sendIt(`/accounting/work-orders/${w.id}`)} /></td>
              </tr>
            ))}</tbody></table>
          ) : <Empty>No completed work orders with costs yet.</Empty>}
        </>
      )}
    </div>
  );
}

/** Pay period page: whether this period has gone to Bigcapital. */
export function PayPeriodAccounting({ periodId, approved }: { periodId: string; approved: boolean }) {
  const { can } = useAuth();
  const status = useApi<Status>(can("admin", "payroll") ? "/accounting/status" : null);
  const send = useAction();
  const st = status.data;
  if (!st?.connected || !approved) return null;
  const p = st.payroll.find((x) => x.id === periodId);
  return (
    <div className="card row" style={{ justifyContent: "space-between" }}>
      <span>Bigcapital: {p?.posting?.status === "posted" ? `sent${p.posting.externalId ? ` as journal #${p.posting.externalId}` : ""} (${money(p.posting.amountCents)})` : p?.posting?.status === "failed" ? `not sent: ${p.posting.error}` : "not sent yet"}</span>
      <span className="row" style={{ gap: 6 }}>
        <ErrorBox error={send.error} />
        {p?.posting?.status === "posted"
          ? p.changedSincePosting && <span className="muted" style={{ fontSize: 12, color: "var(--warn)" }}>Reopened and approved again since it was sent: adjust the journal in Bigcapital</span>
          : <SyncCell posting={p?.posting ?? null} changed={false} busy={send.busy} onSend={() => send.run(async () => { try { await api(`/accounting/payroll/${periodId}`, { method: "POST" }); } finally { status.reload(); } })} />}
      </span>
    </div>
  );
}

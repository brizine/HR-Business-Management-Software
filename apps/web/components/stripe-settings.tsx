"use client";
import { useState } from "react";
import { api, fmtDateTime } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";

type Status = { connected: false } | { connected: true; mode: "test" | "live"; publishableKey: string; accountName: string | null; webhook: boolean; connectedAt: string | null; isTestCompany: boolean };

/**
 * Online payments (Stripe): the owner pastes the company's two Stripe keys. Crewdesk checks them,
 * saves the secret key encrypted and sets up the webhook Stripe uses to report payments.
 */
export function StripeCard() {
  const { can, me } = useAuth();
  const owner = can("owner", "customers");
  const status = useApi<Status>("/stripe/settings");
  const [editing, setEditing] = useState(false);
  const [pk, setPk] = useState("");
  const [sk, setSk] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const action = useAction();
  const s = status.data;
  const isTest = !!me?.company.isTest;
  const want = isTest ? "test" : "live";

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0 }}>Online payments (Stripe)</h2>
          <p className="muted" style={{ margin: "4px 0 0" }}>Customers pay invoices by card or bank account from the pay link in their invoice email, or from the customer portal. Card and bank details go straight to Stripe and never touch Crewdesk.</p>
        </div>
        {s?.connected && <a className="btn" href={s.mode === "test" ? "https://dashboard.stripe.com/test/payments" : "https://dashboard.stripe.com/payments"} target="_blank" rel="noopener noreferrer">Open Stripe ↗</a>}
      </div>
      <ErrorBox error={status.error} />
      {s?.connected && !editing && (
        <>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <span className={`badge ${s.mode === "live" ? "ok" : "warn"}`}>{s.mode === "live" ? "Live: real payments" : "Test mode: no real money"}</span>
            <span>{s.accountName ?? "Stripe account"}</span>
            {s.connectedAt && <span className="muted">· connected {fmtDateTime(s.connectedAt)}</span>}
          </div>
          {!s.webhook && <p className="notice warn" style={{ margin: 0 }}>Stripe can&apos;t send payment updates to this server (it isn&apos;t on a public https address), so Crewdesk checks clearing bank payments with Stripe once an hour instead. On management.prospray.net this is set up automatically.</p>}
          {s.mode === "test" && !isTest && <p className="notice warn" style={{ margin: 0 }}>These are test keys, so customers can&apos;t really pay. Switch to your live keys before sending real invoices.</p>}
          {owner && (
            <div className="row">
              <button className="btn" onClick={() => { setEditing(true); setNote(null); }}>Change keys</button>
              <button className="btn danger" disabled={action.busy} onClick={() => confirm("Turn off online payments? Pay links will show the invoice but no Pay button.") && action.run(async () => { await api("/stripe/settings", { method: "DELETE" }); status.reload(); })}>Disconnect</button>
            </div>
          )}
        </>
      )}
      {s && (!s.connected || editing) && (owner ? (
        <form className="stack" onSubmit={(e) => {
          e.preventDefault();
          action.run(async () => {
            const r = await api<{ mode: string; accountName: string | null; webhook: boolean }>("/stripe/settings", { method: "PUT", body: { publishableKey: pk.trim(), secretKey: sk.trim() } });
            setPk(""); setSk(""); setEditing(false);
            setNote(`Connected${r.accountName ? ` to ${r.accountName}` : ""} in ${r.mode} mode.`);
            status.reload();
          });
        }}>
          <p className="muted" style={{ margin: 0 }}>
            In Stripe: <strong>Developers → API keys</strong>{want === "test" ? <> with <strong>Test mode</strong> on</> : ""}. Copy the <strong>Publishable key</strong> ({want === "test" ? "pk_test_…" : "pk_live_…"}) and the <strong>Secret key</strong> ({want === "test" ? "sk_test_…" : "sk_live_…"}; click Reveal).
            {isTest ? " The test company only takes test keys, so no real money moves." : " Use test keys in the test company first."}
          </p>
          <div className="formgrid">
            <label>Publishable key<input value={pk} onChange={(e) => setPk(e.target.value)} placeholder={`pk_${want}_…`} autoComplete="off" spellCheck={false} required /></label>
            <label>Secret key
              <input type="password" value={sk} onChange={(e) => setSk(e.target.value)} placeholder={`sk_${want}_…`} autoComplete="off" spellCheck={false} required />
              <span className="muted" style={{ fontSize: 12 }}>Stored encrypted; never shown again. Don&apos;t email or text it to anyone.</span>
            </label>
          </div>
          <ErrorBox error={action.error} />
          <div className="row">
            <button className="btn primary" disabled={action.busy || !pk || !sk}>{action.busy ? "Checking with Stripe…" : "Connect"}</button>
            {editing && <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>}
          </div>
        </form>
      ) : <p className="muted" style={{ margin: 0 }}>Not set up yet. The owner connects Stripe here.</p>)}
      {note && <p className="muted" role="status" style={{ margin: 0 }}>{note}</p>}
      {!editing && <ErrorBox error={action.error} />}
    </div>
  );
}

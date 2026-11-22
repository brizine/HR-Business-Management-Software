"use client";
import Link from "next/link";
import { useState } from "react";
import { CREDIT_REASONS, CREDIT_REASON_LABELS, formatMoney, type CreditReason } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";

/* Customer credits: add one, see what's on the account, where it was used, take it off or void it. */

type Credit = {
  id: string; number: number; amountCents: number; appliedCents: number; leftCents: number; reason: CreditReason; description: string; note: string | null;
  issuedOn: string; status: "open" | "void"; voidReason: string | null; createdBy: string | null; property: { id: string; address: string } | null;
  applications: { id: string; invoiceId: string; invoiceNumber: number | null; amountCents: number; appliedOn: string }[];
  books: { status: string; error: string | null } | null;
};

/** Adds a credit for a customer (optionally one property), and uses it now or keeps it for the next invoice. */
export function CreditForm({ customerId, properties, propertyId, invoiceId, onDone, onClose }: {
  customerId: string; properties: { id: string; address: string }[]; propertyId?: string; invoiceId?: string; onDone: () => void; onClose: () => void;
}) {
  const open = useApi<{ rows: { id: string; number: number; balanceCents: number; propertyId: string | null; dueDate: string }[] }>(`/invoices?status=open&customerId=${customerId}&limit=50`);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState<CreditReason>("service_issue");
  const [description, setDescription] = useState("");
  const [note, setNote] = useState("");
  const [prop, setProp] = useState(propertyId ?? "");
  const [applyTo, setApplyTo] = useState(invoiceId ?? "open");
  const { busy, error, run } = useAction();
  const cents = Math.round(Number(amount) * 100);
  const valid = Number.isFinite(cents) && cents > 0 && description.trim().length > 0;
  const invoices = (open.data?.rows ?? []).filter((r) => !prop || r.propertyId === prop);
  return (
    <form className="card stack credit-form" onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        await api("/credits", { body: { customerId, propertyId: prop || null, amountCents: cents, reason, description: description.trim(), note: note.trim() || undefined, applyTo } });
        onDone();
      });
    }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>Add a credit</h3>
      <p className="muted" style={{ margin: 0 }}>Lowers what the customer owes. Use it on an invoice now, or keep it on their account for the next invoice.</p>
      <div className="formgrid">
        <label>Amount ($)<input inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="20.00" autoFocus /></label>
        <label>Reason<select value={reason} onChange={(e) => setReason(e.target.value as CreditReason)}>
          {CREDIT_REASONS.filter((r) => r !== "refund_writeoff").map((r) => <option key={r} value={r}>{CREDIT_REASON_LABELS[r]}</option>)}
        </select></label>
      </div>
      <label>Description (the customer sees this)<input required maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Missed the back yard on 5/12" /></label>
      {properties.length > 0 && (
        <label>For
          <select value={prop} onChange={(e) => { setProp(e.target.value); if (applyTo !== "open" && applyTo !== "none") setApplyTo("open"); }}>
            <option value="">Any of their properties</option>
            {properties.map((p) => <option key={p.id} value={p.id}>Only {p.address}</option>)}
          </select>
        </label>
      )}
      <label>Use it
        <select value={applyTo} onChange={(e) => setApplyTo(e.target.value)}>
          <option value="open">On open invoices now (oldest first)</option>
          <option value="none">Keep it on the account for the next invoice</option>
          {invoices.map((r) => <option key={r.id} value={r.id}>On invoice {r.number} only ({formatMoney(r.balanceCents)} owed)</option>)}
        </select>
      </label>
      <label>Note for the office (optional)<input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Crew skipped it; Joe approved" /></label>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy || !valid}>{busy ? "Adding…" : `Add ${valid ? formatMoney(cents) : ""} credit`}</button>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

/** The customer's credits: what's on the account, each credit, and where it was used. */
export function CustomerCredits({ customerId, properties, onChange }: { customerId: string; properties: { id: string; address: string }[]; onChange?: () => void }) {
  const list = useApi<{ credits: Credit[]; availableCents: number }>(`/credits?customerId=${customerId}`);
  const [adding, setAdding] = useState(false);
  const [showVoid, setShowVoid] = useState(false);
  const action = useAction();
  const reload = () => { list.reload(); onChange?.(); };
  const credits = list.data?.credits ?? [];
  const shown = credits.filter((c) => showVoid || c.status !== "void");
  const voided = credits.length - credits.filter((c) => c.status !== "void").length;
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2 style={{ fontSize: 16, margin: 0 }}>Credits</h2>
          {list.data && <p className="muted" style={{ margin: "2px 0 0" }}>{list.data.availableCents > 0 ? <><strong className="ok-text">{formatMoney(list.data.availableCents)}</strong> on the account, used on the next invoice</> : "No credit on the account"}</p>}
        </div>
        <button className="btn" onClick={() => setAdding(!adding)}>Add credit</button>
      </div>
      {adding && <CreditForm customerId={customerId} properties={properties} onDone={() => { setAdding(false); reload(); }} onClose={() => setAdding(false)} />}
      <ErrorBox error={list.error ?? action.error} />
      {shown.length > 0 && (
        <ul className="plain-list credit-list">
          {shown.map((c) => (
            <li key={c.id} style={{ opacity: c.status === "void" ? 0.55 : 1 }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                <span>
                  <strong>{formatMoney(c.amountCents)}</strong> · CR-{c.number} · {c.description}
                  {c.status === "void" ? <> <span className="badge bad">void</span></> : c.leftCents > 0 ? <> <span className="badge ok">{formatMoney(c.leftCents)} left</span></> : <> <span className="badge">used</span></>}
                  <div className="muted" style={{ fontSize: 13 }}>
                    {fmtDate(c.issuedOn)} · {CREDIT_REASON_LABELS[c.reason] ?? c.reason}{c.property ? ` · only ${c.property.address}` : ""}{c.createdBy ? ` · by ${c.createdBy}` : ""}{c.note ? ` · ${c.note}` : ""}
                    {c.voidReason ? ` · voided: ${c.voidReason}` : ""}
                    {c.books && c.books.status === "failed" && <span className="bad-text"> · Bigcapital: not sent yet ({c.books.error})</span>}
                  </div>
                  {c.applications.map((a) => (
                    <div key={a.id} className="muted" style={{ fontSize: 13 }}>
                      ↳ {formatMoney(a.amountCents)} on <Link href={`/invoices/${a.invoiceId}`}>invoice {a.invoiceNumber}</Link> ({fmtDate(a.appliedOn)}){" "}
                      <button className="linkbtn" disabled={action.busy} onClick={() => confirm(`Take ${formatMoney(a.amountCents)} off invoice ${a.invoiceNumber}? It goes back on the account.`) && action.run(async () => { await api(`/credits/applications/${a.id}/remove`, { method: "POST" }); reload(); })}>take off</button>
                    </div>
                  ))}
                </span>
                {c.status !== "void" && (
                  <button className="btn" disabled={action.busy} onClick={() => {
                    const reason = prompt(`Void credit CR-${c.number}? It comes off any invoices it's on, and they owe it again. Reason:`);
                    if (reason?.trim()) action.run(async () => { await api(`/credits/${c.id}/void`, { body: { reason: reason.trim() } }); reload(); });
                  }}>Void</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {voided > 0 && <button className="linkbtn" onClick={() => setShowVoid(!showVoid)}>{showVoid ? "Hide" : "Show"} voided credits ({voided})</button>}
      {!list.loading && credits.length === 0 && !adding && <p className="muted" style={{ margin: 0 }}>None yet. Add one for a missed service, a goodwill gesture or a billing correction.</p>}
    </div>
  );
}

/** On an invoice: the credits on it (take one off), and using credit from the account. */
export function InvoiceCredits({ invoice, onChange }: { invoice: any; onChange: () => void }) {
  const [picking, setPicking] = useState(false);
  const [creditId, setCreditId] = useState("");
  const [amount, setAmount] = useState("");
  const action = useAction();
  const canUse = (invoice.status === "sent" || invoice.status === "partial") && invoice.openCredits?.length > 0;
  if (!invoice.credits?.length && !canUse) return null;
  const chosen = invoice.openCredits?.find((c: any) => c.id === creditId);
  const max = chosen ? Math.min(chosen.leftCents, invoice.balanceCents) : 0;
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Credits</h2>
        {canUse && !picking && <button className="btn" onClick={() => { setPicking(true); const c = invoice.openCredits[0]; setCreditId(c.id); setAmount((Math.min(c.leftCents, invoice.balanceCents) / 100).toFixed(2)); }}>Use credit ({formatMoney(invoice.availableCreditCents)} available)</button>}
      </div>
      {invoice.credits?.length > 0 && (
        <ul className="plain-list" style={{ marginTop: 8 }}>
          {invoice.credits.map((c: any) => (
            <li key={c.id} className="row" style={{ justifyContent: "space-between" }}>
              <span><strong>−{formatMoney(c.amountCents)}</strong> CR-{c.number} · {c.description} <span className="muted">· {fmtDate(c.appliedOn)}</span></span>
              <button className="btn" disabled={action.busy} onClick={() => confirm("Take this credit off the invoice? It goes back on the customer's account.") && action.run(async () => { await api(`/credits/applications/${c.id}/remove`, { method: "POST" }); onChange(); })}>Take off</button>
            </li>
          ))}
        </ul>
      )}
      {picking && (
        <form className="row" style={{ marginTop: 10, flexWrap: "wrap", alignItems: "flex-end" }} onSubmit={(e) => {
          e.preventDefault();
          action.run(async () => { await api(`/credits/${creditId}/apply`, { body: { invoiceId: invoice.id, amountCents: Math.round(Number(amount) * 100) } }); setPicking(false); onChange(); });
        }}>
          <label>Credit<select value={creditId} onChange={(e) => { setCreditId(e.target.value); const c = invoice.openCredits.find((x: any) => x.id === e.target.value); if (c) setAmount((Math.min(c.leftCents, invoice.balanceCents) / 100).toFixed(2)); }}>
            {invoice.openCredits.map((c: any) => <option key={c.id} value={c.id}>CR-{c.number} · {c.description} ({formatMoney(c.leftCents)} left)</option>)}
          </select></label>
          <label>Amount ($)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 110 }} /></label>
          <button className="btn primary" disabled={action.busy || !(Number(amount) > 0) || Math.round(Number(amount) * 100) > max}>Use it</button>
          <button type="button" className="btn" onClick={() => setPicking(false)}>Cancel</button>
        </form>
      )}
      <ErrorBox error={action.error} />
    </div>
  );
}

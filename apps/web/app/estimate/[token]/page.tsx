"use client";
import { use, useEffect, useState } from "react";
import { depositCents, estimateTotals, formatMoney, formatTaxRate, visitsText, type DepositRule } from "@crewdesk/shared";
import { API_URL, api } from "@/lib/api";
import { PortalFrame, StripePay, longDate, type PortalCompany, type PortalPayments } from "@/components/portal";

type Deposit = { rule: DepositRule | null; words: string | null; cents: number; status: "paid" | "clearing" | "requested" | "due" | "none"; online: boolean };
type Data = {
  company: PortalCompany; taxName: string; canRespond: boolean; payments: PortalPayments; accepted?: boolean; status?: string;
  estimate: {
    number: number; title: string | null; status: string; statusLabel: string; issueDate: string; validUntil: string | null; expired: boolean; discountPercent: number;
    customer: { name: string }; serviceAddress: string | null; terms: string | null; customerNotes: string | null; respondedAt: string | null; responseName: string | null; responseComment: string | null;
    subtotalCents: number; discountCents: number; taxCents: number; totalCents: number; deposit: Deposit | null;
    lines: { id: string; description: string; quantity: number; unitPriceCents: number; visits: number; taxRate: number; amountCents: number; optional: boolean; selected: boolean; recommended: boolean; included: boolean; address: string | null }[];
  };
};

/** The customer's estimate link (from the email): see it, choose options, and accept, decline or ask for changes. No sign-in. */
export default function EstimatePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<null | "accept" | "decline" | "changes">(null);
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const load = (d: Data) => { setData(d); setChosen(new Set(d.estimate.lines.filter((l) => l.optional && l.included).map((l) => l.id))); };
  const [paidNote, setPaidNote] = useState<string | null>(null);
  useEffect(() => {
    // Back from a bank or card check that needed its own page: record how the deposit went.
    const url = new URL(window.location.href);
    const pi = url.searchParams.get("payment_intent");
    if (pi) {
      for (const k of ["payment_intent", "payment_intent_client_secret", "redirect_status"]) url.searchParams.delete(k);
      window.history.replaceState(window.history.state, "", url.pathname);
      api<Data>(`/public/estimates/${token}/deposit/confirm`, { body: { paymentIntentId: pi } }).then(load, () => api<Data>(`/public/estimates/${token}`).then(load, (e) => setError((e as Error).message)));
      return;
    }
    api<Data>(`/public/estimates/${token}`).then(load, (e) => setError((e as Error).message));
  }, [token]);
  if (error) return <PortalFrame company={null}><div className="pt-card"><h1 className="pt-h1">Estimate not found</h1><p className="pt-note bad">{error}</p></div></PortalFrame>;
  if (!data) return <PortalFrame company={null}><p className="pt-muted">Loading…</p></PortalFrame>;
  const e = data.estimate;
  const live = data.canRespond;
  const t = live ? estimateTotals(e.lines.map((l) => ({ ...l, selected: chosen.has(l.id) })), e.discountPercent) : e;
  const taxed = e.lines.some((l) => l.taxRate > 0);
  // The deposit for what they've ticked (it follows their choices), or what was paid.
  const dep = e.deposit;
  const depNow = !dep ? 0 : live && (dep.status === "due" || dep.status === "requested" || dep.status === "none") ? depositCents(dep.rule, t.totalCents) : dep.cents;
  const payDeposit = live && depNow > 0 && dep!.online && data.payments.enabled;
  const respond = async (action: "accept" | "decline" | "changes") => {
    setBusy(true); setFormError(null);
    try { load(await api<Data>(`/public/estimates/${token}/respond`, { body: { action, selectedLineIds: [...chosen], name: name || undefined, comment: comment || undefined } })); setMode(null); }
    catch (err) { setFormError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <PortalFrame company={data.company} right={<a className="pt-link" href={`${API_URL}/public/estimates/${token}/pdf`} target="_blank" rel="noopener noreferrer">PDF</a>}>
      <div className="pt-card">
        <div className="pt-row static" style={{ padding: 0, alignItems: "flex-start" }}>
          <div>
            <div className="pt-label">Estimate {e.number} for {e.customer.name}</div>
            <h1 className="pt-h1" style={{ margin: "4px 0" }}>{e.title || `Estimate ${e.number}`}</h1>
            <div className="pt-muted">{longDate(e.issueDate)}{e.validUntil ? ` · good until ${longDate(e.validUntil)}` : ""}{e.serviceAddress ? ` · ${e.serviceAddress}` : ""}</div>
          </div>
          <div className="pt-right"><div className="pt-amount">{formatMoney(t.totalCents)}</div></div>
        </div>
        {e.status === "accepted" && <p className="pt-note ok" role="status">Accepted{e.responseName ? ` by ${e.responseName}` : ""} on {longDate(e.respondedAt!.slice(0, 10))}{dep?.status === "paid" ? `, with a ${formatMoney(dep.cents)} deposit` : dep?.status === "clearing" ? `, with a ${formatMoney(dep.cents)} deposit from your bank (clearing)` : ""}. Thank you! We&apos;ll be in touch to schedule.</p>}
        {paidNote && <p className="pt-note ok" role="status">{paidNote}</p>}
        {e.status === "declined" && <p className="pt-note warn" role="status">You declined this estimate. Changed your mind? Call or email us.</p>}
        {e.status === "changes" && <p className="pt-note warn" role="status">You asked for changes{e.responseComment ? `: "${e.responseComment}"` : ""}. We&apos;ll send an updated estimate. You can still accept this one as it is.</p>}
        {e.expired && <p className="pt-note warn">This estimate has expired. Call or email us for an updated one.</p>}

        <ul className="pt-list" style={{ marginTop: 12 }}>
          {e.lines.map((l) => {
            const inNow = live ? !l.optional || chosen.has(l.id) : l.included;
            return (
              <li key={l.id} className={`pt-row static est-pt-line${inNow ? "" : " out"}`}>
                <span>
                  {live && l.optional ? (
                    <label className="pt-check" style={{ marginTop: 0 }}>
                      <input type="checkbox" checked={chosen.has(l.id)} onChange={(ev) => { const n = new Set(chosen); if (ev.target.checked) n.add(l.id); else n.delete(l.id); setChosen(n); }} />
                      <span><strong>{l.description}</strong>{l.recommended && <span className="pt-pill ok" style={{ marginLeft: 6 }}>Recommended</span>} <span className="pt-muted">(optional)</span></span>
                    </label>
                  ) : <><strong>{l.description}</strong>{l.recommended && <span className="pt-pill ok" style={{ marginLeft: 6 }}>Recommended</span>}{l.optional && <span className="pt-muted"> (optional{inNow ? "" : ", not included"})</span>}</>}
                  <span className="pt-muted block">{l.visits > 1 ? `${l.quantity !== 1 ? `${l.quantity} × ${formatMoney(l.unitPriceCents)} each visit · ` : ""}${visitsText(l)}` : l.quantity !== 1 ? `${l.quantity} × ${formatMoney(l.unitPriceCents)}` : formatMoney(l.unitPriceCents)}{l.taxRate ? ` · tax ${formatTaxRate(l.taxRate)}` : ""}{l.address ? ` · ${l.address}` : ""}</span>
                </span>
                <span className="pt-right"><strong>{formatMoney(l.amountCents)}</strong></span>
              </li>
            );
          })}
        </ul>
        <dl className="pt-facts est-pt-totals">
          <dt>Subtotal</dt><dd>{formatMoney(t.subtotalCents)}</dd>
          {t.discountCents > 0 && <><dt>Discount ({e.discountPercent}%)</dt><dd>-{formatMoney(t.discountCents)}</dd></>}
          {(taxed || t.taxCents > 0) && <><dt>{data.taxName || "Sales tax"}</dt><dd>{formatMoney(t.taxCents)}</dd></>}
          <dt><strong>Total</strong></dt><dd><strong>{formatMoney(t.totalCents)}</strong></dd>
          {depNow > 0 && <><dt>{dep!.status === "paid" ? "Deposit paid" : dep!.status === "clearing" ? "Deposit (clearing)" : "Deposit to accept"}</dt><dd>{formatMoney(depNow)}</dd></>}
        </dl>
        {live && depNow > 0 && <p className="pt-muted small">{payDeposit ? `A ${formatMoney(depNow)} deposit is paid when you accept. It goes toward your invoices for this work.` : `A ${formatMoney(depNow)} deposit is due before we start. We'll contact you about it after you accept.`}</p>}
        {e.customerNotes && <><h2 className="pt-h2">Notes</h2><p style={{ whiteSpace: "pre-wrap" }}>{e.customerNotes}</p></>}
        {e.terms && <><h2 className="pt-h2">Terms</h2><p className="pt-muted" style={{ whiteSpace: "pre-wrap" }}>{e.terms}</p></>}
      </div>

      {live && (
        <div className="pt-card pt-pay">
          {mode === null && (
            <div className="pt-actions" style={{ flexWrap: "wrap" }}>
              <button className="pt-btn primary big" onClick={() => setMode("accept")}>{payDeposit ? `Accept and pay ${formatMoney(depNow)} deposit` : `Accept ${formatMoney(t.totalCents)}`}</button>
              <button className="pt-btn" onClick={() => setMode("changes")}>Ask for changes</button>
              <button className="pt-btn" onClick={() => setMode("decline")}>Decline</button>
            </div>
          )}
          {mode === "accept" && payDeposit && (
            <div>
              <h2 className="pt-h2">Accept the estimate</h2>
              <p className="pt-muted">Type your name to accept {e.title ? `"${e.title}"` : `estimate ${e.number}`} for {formatMoney(t.totalCents)}{e.terms ? " and its terms" : ""}, then pay the {formatMoney(depNow)} deposit. It&apos;s accepted once the deposit goes through.</p>
              <label className="pt-field">Your name<input required autoComplete="name" value={name} onChange={(ev) => setName(ev.target.value)} autoFocus /></label>
              <label className="pt-field">Anything we should know? (optional)<textarea rows={2} value={comment} onChange={(ev) => setComment(ev.target.value)} /></label>
              {!name.trim() && <p className="pt-muted small">Type your name to continue to the payment.</p>}
              <div className="pt-actions"><button type="button" className="pt-btn" onClick={() => setMode(null)}>Back</button></div>
            </div>
          )}
          {mode === "accept" && !payDeposit && (
            <form onSubmit={(ev) => { ev.preventDefault(); respond("accept"); }}>
              <h2 className="pt-h2">Accept the estimate</h2>
              <p className="pt-muted">Type your name to accept {e.title ? `"${e.title}"` : `estimate ${e.number}`} for {formatMoney(t.totalCents)}{e.terms ? " and its terms" : ""}.</p>
              <label className="pt-field">Your name<input required autoComplete="name" value={name} onChange={(ev) => setName(ev.target.value)} autoFocus /></label>
              <label className="pt-field">Anything we should know? (optional)<textarea rows={2} value={comment} onChange={(ev) => setComment(ev.target.value)} /></label>
              <div className="pt-actions"><button className="pt-btn primary" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Accept"}</button><button type="button" className="pt-btn" onClick={() => setMode(null)}>Back</button></div>
            </form>
          )}
          {(mode === "decline" || mode === "changes") && (
            <form onSubmit={(ev) => { ev.preventDefault(); respond(mode); }}>
              <h2 className="pt-h2">{mode === "changes" ? "Ask for changes" : "Decline the estimate"}</h2>
              <label className="pt-field">{mode === "changes" ? "What would you like changed?" : "Mind telling us why? (optional)"}<textarea rows={3} required={mode === "changes"} value={comment} onChange={(ev) => setComment(ev.target.value)} autoFocus /></label>
              <div className="pt-actions"><button className="pt-btn primary" disabled={busy}>{busy ? "Sending…" : mode === "changes" ? "Send" : "Decline"}</button><button type="button" className="pt-btn" onClick={() => setMode(null)}>Back</button></div>
            </form>
          )}
          {formError && <p className="pt-note bad" role="alert">{formError}</p>}
        </div>
      )}
      {/* The card or bank form, under the accept box once they've typed their name. */}
      {live && mode === "accept" && payDeposit && name.trim() && (
        <StripePay payable dueCents={depNow} payments={data.payments}
          start={async () => {
            const r = await api<any>(`/public/estimates/${token}/deposit`, { body: { name, comment: comment || undefined, selectedLineIds: [...chosen] } });
            if (r.accepted) { load(r); setMode(null); throw new Error("Your deposit was already paid, so the estimate is accepted. Thank you!"); }
            return r;
          }}
          confirm={(paymentIntentId) => api<Data>(`/public/estimates/${token}/deposit/confirm`, { body: { paymentIntentId } })}
          onConfirmed={(r) => { if (r?.estimate) { load(r); setMode(null); setPaidNote(r.estimate.status === "accepted" ? null : "Thank you! We're processing your deposit; the estimate is accepted once it goes through."); } }} />
      )}
    </PortalFrame>
  );
}

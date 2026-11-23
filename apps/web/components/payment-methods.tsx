"use client";
import { useEffect, useRef, useState } from "react";
import { loadStripe, type Stripe, type StripeElements } from "@stripe/stripe-js";
import { cardExpiry, formatMoney } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { isDark } from "@/lib/theme";
import { ErrorBox } from "@/components/ui";

export type SavedMethod = {
  id: string; type: string; label: string; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null;
  bankName: string | null; isDefault: boolean; addedBy: string; expired: boolean;
};

/**
 * Stripe's own form in "save" mode (card, or card or bank account in the portal). `start` asks
 * Crewdesk for a SetupIntent; `finish` tells Crewdesk it went through. The details go straight to
 * Stripe.
 */
export function useStripeSetup(o: { start: () => Promise<{ clientSecret: string; publishableKey: string; setupIntentId: string }>; finish: (setupIntentId: string) => Promise<unknown>; onSaved: () => void }) {
  const [phase, setPhase] = useState<"idle" | "loading" | "form" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const s = useRef<{ stripe: Stripe; elements: StripeElements; id: string } | null>(null);
  const pending = useRef<{ stripe: Stripe; elements: StripeElements; id: string } | null>(null);
  // Coming back from a bank check that needed a new page.
  useEffect(() => {
    const url = new URL(window.location.href);
    const si = url.searchParams.get("setup_intent");
    if (!si) return;
    for (const k of ["setup_intent", "setup_intent_client_secret", "redirect_status"]) url.searchParams.delete(k);
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
    o.finish(si).then(o.onSaved, (e) => setError((e as Error).message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (phase !== "form" || !box.current || !pending.current) return;
    pending.current.elements.create("payment", { layout: "tabs" }).mount(box.current);
    s.current = pending.current;
    pending.current = null;
  }, [phase]);
  const begin = async () => {
    setError(null); setPhase("loading");
    try {
      const r = await o.start();
      const stripe = await loadStripe(r.publishableKey);
      if (!stripe) throw new Error("Couldn't load Stripe's form. Check your connection and try again.");
      const elements = stripe.elements({ clientSecret: r.clientSecret, appearance: { theme: isDark() ? "night" : "stripe", variables: { colorPrimary: "#1f7a3a", borderRadius: "8px" } } });
      pending.current = { stripe, elements, id: r.setupIntentId };
      setPhase("form");
    } catch (e) { setError((e as Error).message); setPhase("idle"); }
  };
  const submit = async () => {
    if (!s.current) return;
    setError(null); setPhase("saving");
    const { stripe, elements, id } = s.current;
    try {
      const { error: err, setupIntent } = await stripe.confirmSetup({ elements, redirect: "if_required", confirmParams: { return_url: window.location.href.split("#")[0] } });
      if (err) { setError(err.message ?? "It wasn't saved."); setPhase("form"); return; }
      await o.finish(setupIntent?.id ?? id);
      s.current = null; setPhase("idle"); o.onSaved();
    } catch (e) { setError((e as Error).message); setPhase("form"); }
  };
  const cancel = () => { s.current = null; pending.current = null; setPhase("idle"); setError(null); };
  return { phase, error, box, begin, submit, cancel };
}

const expiryText = (m: SavedMethod) => (m.type === "card" ? `${m.expired ? "expired" : "expires"} ${cardExpiry(m)}` : "bank account");

/** On a customer's page: their cards and bank accounts on file, autopay, and adding a card from the office. */
export function PaymentMethodsCard({ customerId }: { customerId: string }) {
  const data = useApi<{ autopay: boolean; stripe: { mode: string } | null; methods: SavedMethod[] }>(`/customers/${customerId}/payment-methods`);
  const action = useAction();
  const setup = useStripeSetup({
    start: () => api(`/customers/${customerId}/payment-methods/setup`, { method: "POST" }),
    finish: (setupIntentId) => api(`/customers/${customerId}/payment-methods/finish`, { body: { setupIntentId } }),
    onSaved: () => data.reload(),
  });
  const d = data.data;
  if (!d) return null;
  if (!d.stripe) return null;
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Cards &amp; bank accounts on file</h2>
        {setup.phase === "idle" && <button className="btn" onClick={setup.begin}>Add a card</button>}
      </div>
      {d.stripe.mode === "test" && <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>Stripe test mode: use card 4242 4242 4242 4242, any future date and CVC.</p>}
      {d.methods.length ? (
        <ul className="plain-list" style={{ marginTop: 8 }}>
          {d.methods.map((m) => (
            <li key={m.id} className="row" style={{ justifyContent: "space-between" }}>
              <span>
                <strong>{m.label}</strong> <span className={m.expired ? "bad-text" : "muted"}>· {expiryText(m)}</span>
                {m.isDefault && <span className="badge" style={{ marginLeft: 6 }}>default</span>}
                <span className="muted"> · saved by {m.addedBy === "office" ? "the office" : "the customer"}</span>
              </span>
              <span className="row" style={{ gap: 8 }}>
                {!m.isDefault && <button className="linkbtn" disabled={action.busy} onClick={() => action.run(async () => { await api(`/customers/${customerId}/payment-methods/${m.id}/default`, { method: "POST" }); data.reload(); })}>Make default</button>}
                <button className="linkbtn" disabled={action.busy} onClick={() => confirm(`Remove ${m.label}? It's removed from Stripe too.`) && action.run(async () => { await api(`/customers/${customerId}/payment-methods/${m.id}`, { method: "DELETE" }); data.reload(); })}>Remove</button>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="muted">None yet. Customers can save a card or bank account in the portal (or tick &quot;save for next time&quot; when paying); you can add a card they read out to you.</p>}
      {setup.phase !== "idle" && (
        <div className="card inset stack" style={{ marginTop: 8 }}>
          {setup.phase === "loading" ? <p className="muted">Loading Stripe&apos;s form…</p> : <div ref={setup.box} />}
          <div className="row">
            <button className="btn primary" disabled={setup.phase !== "form"} onClick={setup.submit}>{setup.phase === "saving" ? "Saving…" : "Save card"}</button>
            <button className="btn" onClick={setup.cancel}>Cancel</button>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>The card number goes straight to Stripe; Crewdesk never sees it. Bank accounts need the customer to authorize them, so they add those in the portal.</p>
        </div>
      )}
      <label className="check" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={d.autopay} disabled={action.busy || (!d.methods.length && !d.autopay)}
          onChange={(e) => action.run(async () => { await api(`/customers/${customerId}/autopay`, { method: "PUT", body: { on: e.target.checked } }); data.reload(); })} />
        Autopay: charge the default {d.methods.find((m) => m.isDefault)?.label ?? "card or bank account"} when an invoice is sent
      </label>
      <ErrorBox error={setup.error ?? action.error} />
    </div>
  );
}

/** On an invoice: charge what's owed to a card or bank account on file. */
export function ChargeOnFile({ invoice, onDone }: { invoice: { id: string; customerId: string; status: string; totalCents: number; paidCents: number; creditedCents: number; autopayError?: string | null }; onDone: (msg: string) => void }) {
  const data = useApi<{ stripe: { mode: string } | null; methods: SavedMethod[] }>(`/customers/${invoice.customerId}/payment-methods`);
  const [methodId, setMethodId] = useState<string>("");
  const { busy, error, run } = useAction();
  const owed = invoice.totalCents - invoice.paidCents - invoice.creditedCents;
  const methods = (data.data?.methods ?? []).filter((m) => !m.expired);
  if (!data.data?.stripe || !methods.length || owed <= 0 || invoice.status === "void" || invoice.status === "draft") {
    return invoice.autopayError ? <p className="bad-text">Autopay didn&apos;t go through: {invoice.autopayError}</p> : null;
  }
  const chosen = methods.find((m) => m.id === methodId) ?? methods.find((m) => m.isDefault) ?? methods[0];
  return (
    <div className="card row" style={{ justifyContent: "space-between", gap: 12 }}>
      <div>
        <strong>Charge a card or bank account on file</strong>
        {invoice.autopayError && <div className="bad-text">Autopay didn&apos;t go through: {invoice.autopayError}</div>}
        <ErrorBox error={error} />
      </div>
      <div className="row" style={{ gap: 8 }}>
        {methods.length > 1 && (
          <select value={chosen.id} onChange={(e) => setMethodId(e.target.value)} aria-label="Card or bank account">
            {methods.map((m) => <option key={m.id} value={m.id}>{m.label}{m.isDefault ? " (default)" : ""}</option>)}
          </select>
        )}
        <button className="btn primary" disabled={busy} onClick={() => confirm(`Charge ${formatMoney(owed)} to ${chosen.label}?`) && run(async () => {
          const r = await api<{ status: string; method: string; amountCents: number }>(`/invoices/${invoice.id}/charge`, { body: { methodId: chosen.id } });
          onDone(r.status === "pending" ? `${formatMoney(r.amountCents)} from ${r.method} is on its way (bank payments take about 4 business days to clear).` : `Charged ${formatMoney(r.amountCents)} to ${r.method}.`);
        })}>{busy ? "Charging…" : `Charge ${formatMoney(owed)} to ${methods.length > 1 ? "it" : chosen.label}`}</button>
      </div>
    </div>
  );
}

/** In the portal: the customer's saved cards and bank accounts, adding one, and autopay. */
export function PortalPaymentMethods({ customerId, methods, autopay, staff, testMode, onChange }: {
  customerId: string; methods: SavedMethod[]; autopay: boolean; staff: boolean; testMode?: boolean; onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setup = useStripeSetup({
    start: () => api(`/portal/customers/${customerId}/payment-methods/setup`, { method: "POST" }),
    finish: (setupIntentId) => api(`/portal/customers/${customerId}/payment-methods/finish`, { body: { setupIntentId } }),
    onSaved: onChange,
  });
  const go = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); onChange(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const def = methods.find((m) => m.isDefault);
  return (
    <div className="pt-card">
      <div className="pt-row static" style={{ padding: 0 }}>
        <h2 className="pt-h2" style={{ margin: 0 }}>Payment methods</h2>
        {!staff && setup.phase === "idle" && <button className="pt-link" onClick={setup.begin}>Add a card or bank account</button>}
      </div>
      {methods.length ? (
        <ul className="pt-list" style={{ marginTop: 8 }}>
          {methods.map((m) => (
            <li key={m.id} className="pt-row static">
              <span>{m.label} <span className="pt-muted">· {expiryText(m)}</span>{m.isDefault && <span className="pt-pill ok" style={{ marginLeft: 6 }}>default</span>}</span>
              {!staff && (
                <span className="pt-right">
                  {!m.isDefault && <button className="pt-link" disabled={busy} onClick={() => go(() => api(`/portal/customers/${customerId}/payment-methods/${m.id}/default`, { method: "POST" }))}>Make default</button>}{" "}
                  <button className="pt-link" disabled={busy} onClick={() => confirm(`Remove ${m.label}?`) && go(() => api(`/portal/customers/${customerId}/payment-methods/${m.id}`, { method: "DELETE" }))}>Remove</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : <p className="pt-muted">Save a card or bank account to pay faster next time, or to pay automatically.</p>}
      {setup.phase !== "idle" && (
        <div style={{ marginTop: 8 }}>
          {testMode && <p className="pt-note warn">Test mode: card <strong>4242 4242 4242 4242</strong>, any future date and CVC. For a bank account, choose <strong>Test Institution</strong>.</p>}
          {setup.phase === "loading" ? <p className="pt-muted">Loading…</p> : <div ref={setup.box} className="pt-stripe" />}
          <div className="pt-actions">
            <button className="pt-btn primary" disabled={setup.phase !== "form"} onClick={setup.submit}>{setup.phase === "saving" ? "Saving…" : "Save"}</button>
            <button className="pt-btn" onClick={setup.cancel}>Cancel</button>
          </div>
          <p className="pt-muted small">Your card or bank details go straight to Stripe, our payment processor; we never see or keep them.</p>
        </div>
      )}
      {methods.length > 0 && (
        <label className="pt-check">
          <input type="checkbox" checked={autopay} disabled={staff || busy} onChange={(e) => go(() => api(`/portal/customers/${customerId}/autopay`, { method: "PUT", body: { on: e.target.checked } }))} />
          <span><strong>Pay automatically.</strong> When we send you an invoice, we&apos;ll charge {def?.label ?? "your default payment method"} and email you a receipt. Turn this off any time.</span>
        </label>
      )}
      {(error ?? setup.error) && <p className="pt-note bad" role="alert">{error ?? setup.error}</p>}
    </div>
  );
}

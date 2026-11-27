"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { INCOME_ACCOUNTS, PREPAYMENT_STATUS_LABELS, PREPAY_HOW, PREPAY_HOW_LABELS, formatMoney, lineTextFor, prepayTotals, priceFor, type PrepayHow } from "@crewdesk/shared";
import { api, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox } from "@/components/ui";
import { useServices } from "@/components/invoices";

/* Prepayments (staff): take one (or send a pay link), see what's left, take back the discount, refund the rest. */

type Prop = { id: string; address: string; lawnSqFt?: number | null };
type Line = { serviceTypeId: string; description: string; quantity: number; unitPriceCents: number };
type Prepayment = {
  id: string; number: number; description: string; status: string; method: string | null; methodDetail: string | null; reference: string | null; receivedOn: string | null;
  coversCents: number; discountCents: number; amountCents: number; appliedCents: number; appliedDiscountCents: number; refundedCents: number; discountReversed: boolean;
  cashLeftCents: number; discountLeftCents: number; payLink: string | null; note: string | null; voidReason: string | null; createdBy: string | null; createdAt: string;
  property: { id: string; address: string } | null; lines: Line[];
  uses: { id: string; invoiceId: string; number: number | null; amountCents: number; receivedOn: string }[];
  books: { status: string; error: string | null } | null;
};

const cents = (v: string) => Math.round(Number(v) * 100);

export function PrepaymentForm({ customerId, properties, onDone, onClose }: { customerId: string; properties: Prop[]; onDone: (r: any) => void; onClose: () => void }) {
  const services = useServices();
  const [prop, setProp] = useState(properties.length === 1 ? properties[0].id : "");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<"services" | "amount">("services");
  const [lines, setLines] = useState<Line[]>([]);
  const [amount, setAmount] = useState("");
  const [discountKind, setDiscountKind] = useState<"none" | "percent" | "amount">("percent");
  const [discount, setDiscount] = useState("5");
  const [how, setHow] = useState<PrepayHow>("check");
  const [reference, setReference] = useState("");
  const [useNow, setUseNow] = useState(false);
  const [note, setNote] = useState("");
  const [incomeCode, setIncomeCode] = useState("4000");
  const { busy, error, run } = useAction();
  const sqFt = properties.find((p) => p.id === prop)?.lawnSqFt ?? properties.find((p) => p.lawnSqFt)?.lawnSqFt ?? null;
  const covers = mode === "services" ? lines.reduce((s, l) => s + Math.round(l.quantity * l.unitPriceCents), 0) : cents(amount) || 0;
  const t = prepayTotals(covers, discountKind, discountKind === "amount" ? cents(discount) || 0 : Number(discount) || 0);
  const addService = (id: string) => {
    const s = services.list.find((x) => x.id === id);
    if (!s) return;
    const price = priceFor(s as never, sqFt) ?? 0;
    setLines([...lines, { serviceTypeId: s.id, description: lineTextFor(s, "invoice"), quantity: 1, unitPriceCents: price }]);
    if (!description) setDescription(`${new Date().getFullYear() + (new Date().getMonth() >= 9 ? 1 : 0)} season`);
  };
  const valid = covers > 0 && description.trim() && t.amountCents > 0 && (how !== "check" || reference.trim());
  return (
    <form className="card stack credit-form" onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        const r = await api("/prepayments", { body: {
          customerId, propertyId: prop || null, description: description.trim(), lines: mode === "services" ? lines : [], coversCents: covers,
          discountKind, discountValue: discountKind === "amount" ? cents(discount) || 0 : Number(discount) || 0, incomeAccountCode: incomeCode, how, reference: reference.trim() || undefined, useNow, note: note.trim() || undefined,
        } });
        onDone(r);
      });
    }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>Take a prepayment</h3>
      <p className="muted" style={{ margin: 0 }}>Money paid ahead. It pays this customer&apos;s invoices as they&apos;re sent, each with its share of any prepay discount.</p>
      <div className="formgrid">
        <label>What it covers (the customer sees this)<input required maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="2027 season: rounds 1-7" /></label>
        {properties.length > 0 && (
          <label>For
            <select value={prop} onChange={(e) => setProp(e.target.value)}>
              <option value="">Any of their properties</option>
              {properties.map((p) => <option key={p.id} value={p.id}>Only {p.address}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="row" style={{ gap: 16 }}>
        <label className="check"><input type="radio" checked={mode === "services"} onChange={() => setMode("services")} /> Work it out from services</label>
        <label className="check"><input type="radio" checked={mode === "amount"} onChange={() => setMode("amount")} /> Enter an amount</label>
      </div>
      {mode === "services" ? (
        <div className="stack" style={{ gap: 6 }}>
          {lines.map((l, i) => (
            <div key={i} className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <input style={{ flex: "2 1 220px" }} value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} aria-label="Service" />
              <label className="row" style={{ gap: 4 }}>×<input type="number" min={1} max={50} style={{ width: 64 }} value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)))} aria-label="How many" /></label>
              <label className="row" style={{ gap: 4 }}>$<input inputMode="decimal" style={{ width: 90 }} value={(l.unitPriceCents / 100).toFixed(2)} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unitPriceCents: cents(e.target.value) || 0 } : x)))} aria-label="Price each" /></label>
              <span className="muted" style={{ minWidth: 80, textAlign: "right" }}>{formatMoney(Math.round(l.quantity * l.unitPriceCents))}</span>
              <button type="button" className="linkbtn" onClick={() => setLines(lines.filter((_, j) => j !== i))}>remove</button>
            </div>
          ))}
          <select value="" onChange={(e) => addService(e.target.value)} aria-label="Add a service">
            <option value="">+ Add a service from the price list{sqFt ? ` (priced for ${Math.round(sqFt).toLocaleString()} sq ft)` : ""}</option>
            {services.list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      ) : (
        <div className="formgrid">
          <label>Amount ($)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="500.00" /></label>
          <label>Counts as income in
            <select value={incomeCode} onChange={(e) => setIncomeCode(e.target.value)}>{INCOME_ACCOUNTS.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select>
            <span className="muted" style={{ fontSize: 12 }}>Prepayments are income when received. Services from the price list use their own account.</span>
          </label>
        </div>
      )}
      <div className="formgrid">
        <label>Prepay discount
          <div className="row" style={{ gap: 6 }}>
            <select value={discountKind} onChange={(e) => setDiscountKind(e.target.value as typeof discountKind)}>
              <option value="none">None</option><option value="percent">Percent off</option><option value="amount">Amount off ($)</option>
            </select>
            {discountKind !== "none" && <input inputMode="decimal" style={{ width: 90 }} value={discount} onChange={(e) => setDiscount(e.target.value)} />}
          </div>
        </label>
        <label>How they&apos;re paying
          <select value={how} onChange={(e) => setHow(e.target.value as PrepayHow)}>{PREPAY_HOW.map((h) => <option key={h} value={h}>{PREPAY_HOW_LABELS[h]}</option>)}</select>
        </label>
        {(how === "check" || how === "other") && <label>{how === "check" ? "Check number" : "Reference"}<input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} /></label>}
      </div>
      {covers > 0 && (
        <div className="money-box">
          <div><div className="v">{formatMoney(t.coversCents)}</div><div className="l">Covers</div></div>
          <div><div className="v ok-text">{t.discountCents ? `−${formatMoney(t.discountCents)}` : "—"}</div><div className="l">Prepay discount</div></div>
          <div><div className="v">{formatMoney(t.amountCents)}</div><div className="l">{how === "link" ? "They'll pay" : "Received"}</div></div>
        </div>
      )}
      <label className="check"><input type="checkbox" checked={useNow} onChange={(e) => setUseNow(e.target.checked)} /> Also pay their open invoices with it {how === "link" ? "once it's paid" : "now"} (otherwise it waits for their next invoices)</label>
      <label>Note for the office (optional)<input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy || !valid}>{busy ? "Saving…" : how === "link" ? `Send a pay link for ${formatMoney(t.amountCents)}` : `Record ${formatMoney(t.amountCents)} prepayment`}</button>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

/** The customer's prepayments: balance, each one, what it paid, and what can be done with it. */
export function CustomerPrepayments({ customerId, properties, onChange }: { customerId: string; properties: Prop[]; onChange?: () => void }) {
  const { can } = useAuth();
  const admin = can("admin", "customers");
  const list = useApi<{ prepayments: Prepayment[]; prepaidCents: number }>(`/prepayments?customerId=${customerId}`);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [showOld, setShowOld] = useState(false);
  const action = useAction();
  const reload = () => { list.reload(); onChange?.(); };
  const all = list.data?.prepayments ?? [];
  const shown = useMemo(() => all.filter((p) => showOld || (p.status !== "void" && p.status !== "closed")), [all, showOld]);
  const hidden = all.length - all.filter((p) => p.status !== "void" && p.status !== "closed").length;
  const act = (path: string, body: unknown, done?: string) => action.run(async () => { await api(path, { body }); if (done) setNote(done); reload(); });
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2 style={{ fontSize: 16, margin: 0 }}>Prepayments</h2>
          {list.data && <p className="muted" style={{ margin: "2px 0 0" }}>{list.data.prepaidCents > 0 ? <><strong className="ok-text">{formatMoney(list.data.prepaidCents)}</strong> prepaid, used on their next invoices</> : "Nothing prepaid right now"}</p>}
        </div>
        <button className="btn" onClick={() => { setAdding(!adding); setNote(null); }}>Take a prepayment</button>
      </div>
      {adding && <PrepaymentForm customerId={customerId} properties={properties} onClose={() => setAdding(false)} onDone={(r) => {
        setAdding(false);
        setNote(r.status === "requested" ? (r.emailedTo ? `Pay link emailed to ${r.emailedTo}.` : "Pay link made; copy it below and send it to the customer.") : `PP-${r.number} recorded.`);
        reload();
      }} />}
      {note && <p className="notice" role="status" style={{ margin: 0 }}>{note}</p>}
      <ErrorBox error={list.error ?? action.error} />
      {shown.length > 0 && (
        <ul className="plain-list credit-list">
          {shown.map((p) => (
            <li key={p.id} style={{ opacity: p.status === "void" || p.status === "closed" ? 0.6 : 1 }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                <span>
                  <strong>{formatMoney(p.amountCents)}</strong> · PP-{p.number} · {p.description}{" "}
                  <span className={`badge ${p.status === "open" ? "ok" : p.status === "void" ? "bad" : p.status === "closed" ? "" : "warn"}`}>{PREPAYMENT_STATUS_LABELS[p.status] ?? p.status}</span>
                  {p.status === "open" && <> <span className="badge ok">{formatMoney(p.cashLeftCents)} left</span></>}
                  <div className="muted" style={{ fontSize: 13 }}>
                    {p.receivedOn ? `${fmtDate(p.receivedOn)} · ` : ""}{p.methodDetail ?? (p.method ? p.method[0].toUpperCase() + p.method.slice(1) : "")}{p.reference ? ` #${p.reference}` : ""}
                    {p.discountCents ? ` · covers ${formatMoney(p.coversCents)} with ${formatMoney(p.discountCents)} prepay discount${p.discountReversed ? " (taken back)" : ""}` : ""}
                    {p.property ? ` · only ${p.property.address}` : ""}{p.createdBy ? ` · by ${p.createdBy}` : ""}{p.note ? ` · ${p.note}` : ""}{p.voidReason ? ` · void: ${p.voidReason}` : ""}
                    {p.books?.status === "failed" && <span className="bad-text"> · Bigcapital: not sent yet ({p.books.error})</span>}
                  </div>
                  {p.uses.map((u) => (
                    <div key={u.id} className="muted" style={{ fontSize: 13 }}>↳ {formatMoney(u.amountCents)} paid <Link href={`/invoices/${u.invoiceId}`}>invoice {u.number}</Link> ({fmtDate(u.receivedOn)})</div>
                  ))}
                  {p.payLink && (
                    <div style={{ fontSize: 13, marginTop: 4 }}>
                      Pay link: <a href={p.payLink} target="_blank" rel="noopener noreferrer">{p.payLink.replace(/^https?:\/\//, "")}</a>{" "}
                      <button className="linkbtn" onClick={async () => { try { await navigator.clipboard.writeText(p.payLink!); setNote("Pay link copied."); } catch { window.prompt("Copy this link:", p.payLink!); } }}>copy</button>{" · "}
                      <button className="linkbtn" disabled={action.busy} onClick={() => act(`/prepayments/${p.id}/send-link`, {}, "Pay link emailed again.")}>email again</button>
                    </div>
                  )}
                </span>
                {admin && (
                  <span className="row" style={{ gap: 6, flexShrink: 0 }}>
                    {(p.status === "open" || p.status === "closed") && p.discountCents > 0 && !p.discountReversed && (
                      <button className="btn" disabled={action.busy} title="The customer cancelled: they lose the discount on what was done" onClick={() => confirm(`Take back the prepay discount on PP-${p.number}? Invoices it paid are charged the full price from the prepayment, and no more discount is given.`) && act(`/prepayments/${p.id}/reverse-discount`, {}, "Discount taken back.")}>Take back discount</button>
                    )}
                    {p.status === "open" && p.cashLeftCents > 0 && (
                      <button className="btn" disabled={action.busy} onClick={() => {
                        const online = p.method === "card" || p.method === "ach";
                        const ref = online ? "" : prompt(`Refund ${formatMoney(p.cashLeftCents)} (what's left of PP-${p.number}). How was it paid back? (e.g. "Check 3105")`);
                        if (online ? confirm(`Refund ${formatMoney(p.cashLeftCents)} to ${p.methodDetail ?? "their card"}? This closes PP-${p.number}.`) : ref !== null) act(`/prepayments/${p.id}/refund`, { reference: ref || null }, "Refunded; the prepayment is closed.");
                      }}>Refund the rest</button>
                    )}
                    {(p.status === "requested" || (p.status === "open" && p.appliedCents === 0 && p.method !== "card" && p.method !== "ach")) && (
                      <button className="btn danger" disabled={action.busy} onClick={() => { const r = prompt(`Void PP-${p.number}? Reason:`); if (r?.trim()) act(`/prepayments/${p.id}/void`, { reason: r.trim() }, "Voided."); }}>Void</button>
                    )}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && <button className="linkbtn" onClick={() => setShowOld(!showOld)}>{showOld ? "Hide" : "Show"} closed and void ({hidden})</button>}
      {!list.loading && all.length === 0 && !adding && <p className="muted" style={{ margin: 0 }}>None yet. Take one for a season paid up front, a prepaid service, or money to keep on account.</p>}
    </div>
  );
}

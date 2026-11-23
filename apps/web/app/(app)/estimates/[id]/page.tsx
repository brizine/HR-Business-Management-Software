"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { formatMoney, formatTaxRate, visitsText } from "@crewdesk/shared";
import { API_URL, api, fmtDate } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { ErrorBox, PageHead } from "@/components/ui";
import { EstimateForm, EstimateStatus } from "@/components/estimates";

/** One estimate: what it says, its status and the customer's answer, and the next steps (send, record an answer, make a work order or invoice). */
export default function EstimateDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const est = useApi<any>(`/estimates/${id}`);
  const [panel, setPanel] = useState<null | "edit" | "send" | "answer">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAction();
  const e = est.data;
  if (est.error) return <><PageHead title="Estimate" /><ErrorBox error={est.error} /></>;
  if (!e) return <PageHead title="Estimate" sub="Loading…" />;
  const editable = e.status !== "accepted" && e.status !== "declined";
  const converted = !!(e.visitId || e.invoiceId);
  const taxed = e.lines.some((l: any) => l.taxRate > 0);
  const done = (msg?: string) => { setPanel(null); est.reload(); if (msg) setNotice(msg); };

  return (
    <>
      <PageHead title={`Estimate ${e.number}`} before={<Link className="btn" href="/estimates" aria-label="Back to estimates">←</Link>}
        sub={<><Link href={`/customers/${e.customer.id}`}>{e.customer.name}</Link> · <EstimateStatus status={e.status} expired={e.expired} />{e.title ? ` · ${e.title}` : ""}</>}>
        {editable && <button className="btn primary" onClick={() => setPanel(panel === "send" ? null : "send")}>{e.sentAt ? "Send again" : "Send"}</button>}
        {editable && <button className="btn" onClick={() => setPanel(panel === "edit" ? null : "edit")}>Edit</button>}
        {editable && <button className="btn" onClick={() => setPanel(panel === "answer" ? null : "answer")}>Record their answer</button>}
        {e.status === "accepted" && !e.visitId && <Link className="btn primary" href={`/visits/new?estimateId=${e.id}`}>Make a work order</Link>}
        {e.status === "accepted" && !e.invoiceId && (
          <button className="btn" disabled={action.busy} onClick={() => confirm("Make a draft invoice from the accepted lines?") && action.run(async () => { const r = await api<{ invoiceId: string }>(`/estimates/${e.id}/invoice`, { method: "POST" }); router.push(`/invoices/${r.invoiceId}`); })}>Make an invoice</button>
        )}
        <a className="btn" href={`${API_URL}/estimates/${id}/pdf`} target="_blank" rel="noopener noreferrer">PDF</a>
        <button className="btn" disabled={action.busy} onClick={() => action.run(async () => { const r = await api<{ id: string; number: number }>(`/estimates/${e.id}/copy`, { method: "POST" }); router.push(`/estimates/${r.id}`); })}>Copy</button>
        {(e.status === "accepted" || e.status === "declined") && !converted && (
          <button className="btn" disabled={action.busy} onClick={() => confirm("Undo the answer and put it back to pending?") && action.run(async () => { await api(`/estimates/${e.id}/reopen`, { method: "POST" }); done("Put back to pending."); })}>Undo answer</button>
        )}
        {!converted && <button className="btn danger" disabled={action.busy} onClick={() => confirm(`Delete estimate ${e.number}?`) && action.run(async () => { await api(`/estimates/${e.id}`, { method: "DELETE" }); router.push("/estimates"); })}>Delete</button>}
      </PageHead>
      <ErrorBox error={action.error} />
      {notice && <div className="notice" role="status">{notice} <button type="button" className="linkbtn" onClick={() => setNotice(null)}>OK</button></div>}
      {panel === "send" && <SendEstimate e={e} onDone={() => done(`Emailed to ${e.customer.email ?? "the customer"}.`)} onClose={() => setPanel(null)} />}
      {panel === "answer" && <RecordAnswer e={e} onDone={() => done()} onClose={() => setPanel(null)} />}
      {panel === "edit" ? <EstimateForm estimate={e} onCancel={() => setPanel(null)} onSaved={() => done("Saved.")} /> : (
        <>
          {e.respondedAt && (
            <div className={`card ${e.status === "accepted" ? "ok-card" : e.status === "declined" ? "bad-card" : "warn-card"}`}>
              <strong>{e.status === "accepted" ? `Accepted${e.responseName ? ` by ${e.responseName}` : ""}` : e.status === "declined" ? "Declined" : "Changes requested"}</strong>
              <span className="muted"> · {new Date(e.respondedAt).toLocaleString()}{e.respondedBy === "office" ? ` · recorded by ${e.respondedByName ?? "the office"}` : " · online"}</span>
              {e.responseComment && <p style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}>&ldquo;{e.responseComment}&rdquo;</p>}
              {converted && <p style={{ margin: "6px 0 0" }}>{e.visitId && <Link href={`/visits/${e.visitId}`}>Work order</Link>}{e.visitId && e.invoiceId && " · "}{e.invoiceId && <Link href={`/invoices/${e.invoiceId}`}>Invoice</Link>}</p>}
            </div>
          )}
          <div className="card">
            <div className="money-box">
              <div><div className="v">{formatMoney(e.totalCents)}</div><div className="l">Total{e.lines.some((l: any) => l.optional) ? (e.status === "accepted" ? " (their choice)" : " (with ticked options)") : ""}</div></div>
              <div><div className="v" style={{ fontSize: 16 }}>{fmtDate(e.issueDate)}</div><div className="l">Date</div></div>
              <div><div className="v" style={{ fontSize: 16 }}>{e.validUntil ? fmtDate(e.validUntil) : "—"}</div><div className="l">Good until{e.expired ? " (expired)" : ""}</div></div>
              <div><div className="v" style={{ fontSize: 16 }}>{e.sentAt ? fmtDate(e.sentAt) : "Not sent"}</div><div className="l">{e.sentAt ? `Sent${e.viewedAt ? " · seen" : ""}` : "Sent"}</div></div>
            </div>
            {e.serviceAddress && <p className="muted" style={{ margin: "8px 0 0" }}>Service address: {e.serviceAddress}</p>}
            <div className="tablewrap" style={{ marginTop: 10 }}>
              <table className="invoice-lines">
                <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Visits</th>{taxed && <th className="num">Tax</th>}<th className="num">Total</th></tr></thead>
                <tbody>{e.lines.map((l: any) => (
                  <tr key={l.id} className={l.included ? undefined : "muted"}>
                    <td>
                      {l.description}
                      {(l.optional || l.recommended || l.address) && (
                        <div style={{ fontSize: 12 }}>
                          {l.recommended && <span className="badge ok" style={{ marginRight: 4 }}>Recommended</span>}
                          {l.optional && <span className="badge" style={{ marginRight: 4 }}>{l.included ? "Optional · in" : "Optional · not in"}</span>}
                          {l.address && <span className="muted">{l.address}</span>}
                        </div>
                      )}
                    </td>
                    <td className="num">{l.quantity}</td>
                    <td className="num">{formatMoney(l.unitPriceCents)}</td>
                    <td className="num">{l.visits}</td>
                    {taxed && <td className="num">{l.taxRate ? formatTaxRate(l.taxRate) : "—"}</td>}
                    <td className="num">{l.included ? formatMoney(l.amountCents) : `(${formatMoney(l.amountCents)})`}{visitsText(l) && <div className="muted" style={{ fontSize: 12 }}>{visitsText(l)}</div>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="est-totals">
              <dl className="facts totals">
                <dt>Subtotal</dt><dd>{formatMoney(e.subtotalCents)}</dd>
                {e.discountCents > 0 && <><dt>Discount ({e.discountPercent}%)</dt><dd>-{formatMoney(e.discountCents)}</dd></>}
                {e.taxCents > 0 && <><dt>Sales tax</dt><dd>{formatMoney(e.taxCents)}</dd></>}
                <dt><strong>Total</strong></dt><dd><strong>{formatMoney(e.totalCents)}</strong></dd>
              </dl>
              <dl className="facts totals est-internal" aria-label="For the office only">
                <dt>Per visit</dt><dd>{formatMoney(e.internal.visitsRevenueCents)}</dd>
                <dt>Budgeted hours</dt><dd>{e.internal.hours}</dd>
                <dt>Our cost</dt><dd>{formatMoney(e.internal.costCents)}</dd>
                <dt><strong>Estimated profit</strong></dt><dd><strong>{formatMoney(e.internal.profitCents)}</strong>{e.internal.costCents > 0 ? ` (${e.internal.marginPercent}%)` : ""}</dd>
              </dl>
            </div>
          </div>
          <div className="grid cols-2">
            <div className="card"><h2 style={{ fontSize: 16, marginTop: 0 }}>Terms</h2><p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{e.terms || <span className="muted">None</span>}</p></div>
            <div className="card"><h2 style={{ fontSize: 16, marginTop: 0 }}>Notes for the customer</h2><p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{e.customerNotes || <span className="muted">None</span>}</p></div>
          </div>
          {e.deposit && <DepositBox e={e} onChange={(msg) => done(msg)} />}
          <div className="card">
            <h2 style={{ fontSize: 16, marginTop: 0 }}>For the office</h2>
            <dl className="facts">
              <dt>Internal notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{e.internalNotes || "—"}</dd>
              {e.requestedAt && <><dt>Asked for</dt><dd>{new Date(e.requestedAt).toLocaleString()}</dd></>}
              {e.poNumber && <><dt>P.O. number</dt><dd>{e.poNumber}</dd></>}
              {e.emailedTo && <><dt>Emailed to</dt><dd>{e.emailedTo}</dd></>}
              {e.link && <><dt>Customer&apos;s link</dt><dd><a href={e.link} target="_blank" rel="noopener noreferrer">{e.link.replace(/^https?:\/\//, "").slice(0, 60)}…</a> <button type="button" className="linkbtn" onClick={() => navigator.clipboard.writeText(e.link).then(() => setNotice("Link copied."))}>Copy</button></dd></>}
            </dl>
          </div>
        </>
      )}
    </>
  );
}

/** The deposit to accept: what it is, and whether it's paid (a prepayment), asked for, or still due. */
function DepositBox({ e, onChange }: { e: any; onChange: (msg: string) => void }) {
  const d = e.deposit;
  const { busy, error, run } = useAction();
  const pp = d.prepayment;
  return (
    <div className="card">
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Deposit</h2>
      <dl className="facts">
        {d.words && <><dt>Rule</dt><dd>{d.words}{e.depositMode === "custom" ? " (this estimate's own)" : " (company default)"}</dd></>}
        <dt>Amount</dt><dd>{d.cents > 0 ? formatMoney(d.cents) : "None at this total"}</dd>
        <dt>Status</dt>
        <dd>
          {d.status === "paid" && <span className="ok-text">Paid{pp?.receivedOn ? ` ${fmtDate(pp.receivedOn)}` : ""}{pp?.methodDetail ? ` (${pp.methodDetail})` : ""}</span>}
          {d.status === "clearing" && <span>Bank payment clearing</span>}
          {d.status === "requested" && <span>Asked for, not paid yet</span>}
          {d.status === "due" && <span>{e.status === "accepted" ? "Due" : "Paid online as they accept"}{!d.online ? " (online payments aren't set up, so collect it yourself)" : ""}</span>}
          {d.status === "none" && <span className="muted">Nothing due</span>}
          {pp && <> · <Link href={`/customers/${e.customer.id}#prepayments`}>PP-{pp.number}</Link></>}
        </dd>
      </dl>
      {(d.status === "paid" || d.status === "clearing") && <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>It&apos;s a prepayment on the customer&apos;s account, used on their invoices as they&apos;re sent.</p>}
      {e.status === "accepted" && (d.status === "due" || d.status === "requested") && d.online && (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" disabled={busy} onClick={() => run(async () => { const r = await api<{ emailedTo: string }>(`/estimates/${e.id}/deposit-link`, { body: {} }); onChange(`Deposit link emailed to ${r.emailedTo}.`); })}>
            {d.status === "requested" ? "Email the deposit link again" : "Email a deposit link"}
          </button>
        </div>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

function SendEstimate({ e, onDone, onClose }: { e: any; onDone: () => void; onClose: () => void }) {
  const [to, setTo] = useState("");
  const [message, setMessage] = useState("");
  const { busy, error, run } = useAction();
  return (
    <form className="card stack" onSubmit={(ev) => { ev.preventDefault(); run(async () => { await api(`/estimates/${e.id}/send`, { body: { emailTo: to || undefined, message: message || undefined } }); onDone(); }); }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>{e.sentAt ? "Send again" : "Send"} estimate {e.number}</h2>
      <p className="muted" style={{ margin: 0 }}>It&apos;s emailed with the PDF and a link where they can see it, choose any options and accept, decline or ask for changes. You&apos;ll get a notification when they answer.</p>
      <div className="formgrid">
        <label>To<input type="email" placeholder={e.customer.email ?? "Their email address"} value={to} onChange={(ev) => setTo(ev.target.value)} required={!e.customer.email} /><span className="muted" style={{ fontSize: 12 }}>{e.customer.email ? `Blank: ${e.customer.email}` : "This customer has no email on file"}</span></label>
      </div>
      <label>Message (optional)<textarea rows={3} value={message} onChange={(ev) => setMessage(ev.target.value)} placeholder="Thanks for having us out today. Here's the estimate we talked about." /></label>
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>{busy ? "Sending…" : "Send"}</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </form>
  );
}

/** The customer answered by phone or in person: accept (with their choice of options), decline, or changes. */
function RecordAnswer({ e, onDone, onClose }: { e: any; onDone: () => void; onClose: () => void }) {
  const [action, setAction] = useState<"accept" | "decline" | "changes">("accept");
  const [picked, setPicked] = useState<string[]>(e.lines.filter((l: any) => l.optional && l.selected).map((l: any) => l.id));
  const [comment, setComment] = useState("");
  const { busy, error, run } = useAction();
  const optional = e.lines.filter((l: any) => l.optional);
  return (
    <form className="card stack" onSubmit={(ev) => { ev.preventDefault(); run(async () => { await api(`/estimates/${e.id}/respond`, { body: { action, selectedLineIds: picked, comment: comment || undefined } }); onDone(); }); }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>Record their answer</h2>
      <div className="row">
        {([["accept", "Accepted"], ["decline", "Declined"], ["changes", "Wants changes"]] as const).map(([k, l]) => (
          <label key={k} className="check"><input type="radio" name="answer" checked={action === k} onChange={() => setAction(k)} /> {l}</label>
        ))}
      </div>
      {action === "accept" && optional.length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          <span className="todo-label">Options they want</span>
          {optional.map((l: any) => (
            <label key={l.id} className="check"><input type="checkbox" checked={picked.includes(l.id)} onChange={(ev) => setPicked(ev.target.checked ? [...picked, l.id] : picked.filter((x) => x !== l.id))} /> {l.description} ({formatMoney(l.amountCents)})</label>
          ))}
        </div>
      )}
      <label>{action === "changes" ? "What they'd like changed *" : action === "decline" ? "Why (optional)" : "Note (optional)"}<textarea rows={2} value={comment} required={action === "changes"} onChange={(ev) => setComment(ev.target.value)} /></label>
      <ErrorBox error={error} />
      <div className="row"><button className="btn primary" disabled={busy}>Save</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </form>
  );
}

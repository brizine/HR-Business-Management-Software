"use client";
import Link from "next/link";
import { useState } from "react";
import { DELIVERY_LABELS, DELIVERY_METHODS, formatMoney, isInactive, visitNumber } from "@crewdesk/shared";
import { api, fmtDate, today as localToday } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox } from "@/components/ui";
import { customerBody, customerFormValue } from "@/components/customers";
import { visitWhen, type Visit } from "@/components/visits";
import { PackageRows, usePackagesOn } from "@/components/packages";
import { CustomerBillingRules, describeCustomerRules } from "@/components/billing-rules";

/**
 * Boxes on a customer's page, laid out like Homeworks': the account summary with a revenue
 * projection, customer notes, call notes and the timeline, work orders, payments by month, stats, delivery
 * preference, invoice defaults and the customer portal.
 */

type Summary = { outstandingCents: number; pastDueCents: number; paidThisYearCents: number; creditCents: number; prepaidCents: number };
type Stats = {
  collectedCents: number; balanceCents: number; pastDueInvoices: number; visitsDone: number; averageVisitCents: number; lastService: string | null; nextService: string | null;
  projection: { todayCents: number; weekCents: number; monthCents: number; yearCents: number };
};

/** Past due, outstanding, paid this year, credit and prepaid; a payment button; what scheduled work will bring in. */
export function AccountBox({ customerId, name, onPay }: { customerId: string; name: string; onPay: () => void }) {
  const s = useApi<Summary>(`/invoices/customer-summary/${customerId}`).data;
  const stats = useApi<Stats>(`/customers/${customerId}/stats`).data;
  const [showProjection, setShowProjection] = useState(false);
  const [period, setPeriod] = useState<"todayCents" | "weekCents" | "monthCents" | "yearCents">("monthCents");
  if (!s) return <div className="card cp-account"><p className="muted">Loading…</p></div>;
  const row = (label: string, cents: number, cls?: string) => <div className="cp-row"><span>{label}</span><strong className={cls}>{formatMoney(cents)}</strong></div>;
  return (
    <div className="card cp-account">
      <div className="row" style={{ justifyContent: "space-between" }}><strong>{name}</strong><button type="button" className="btn" onClick={onPay}>Record payment</button></div>
      {row("Past due", s.pastDueCents, s.pastDueCents ? "bad-text" : undefined)}
      {row("Outstanding", s.outstandingCents)}
      {row("Paid this year", s.paidThisYearCents)}
      {row("Credit", s.creditCents, s.creditCents ? "ok-text" : undefined)}
      {s.prepaidCents > 0 && row("Prepaid", s.prepaidCents, "ok-text")}
      <button type="button" className="btn cp-proj-btn" aria-expanded={showProjection} onClick={() => setShowProjection(!showProjection)}>{showProjection ? "Hide" : "Show"} revenue projection</button>
      {showProjection && stats && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="cal-seg" role="tablist" aria-label="Period">
            {([["todayCents", "Today"], ["weekCents", "This week"], ["monthCents", "This month"], ["yearCents", "This year"]] as const).map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={period === k} aria-pressed={period === k} style={{ width: "auto", padding: "0 10px" }} onClick={() => setPeriod(k)}>{l}</button>
            ))}
          </div>
          {stats.projection[period] ? <div className="cp-row"><span>Scheduled work</span><strong>{formatMoney(stats.projection[period])}</strong></div>
            : <p className="muted" style={{ margin: 0 }}>No scheduled work in that time.</p>}
          <span className="muted" style={{ fontSize: 12 }}>Open work orders to be invoiced, from today on.</span>
        </div>
      )}
    </div>
  );
}

/** Like Homeworks' Customer Stat box. */
export function StatsBox({ customerId }: { customerId: string }) {
  const s = useApi<Stats>(`/customers/${customerId}/stats`).data;
  if (!s) return null;
  return (
    <div className="card">
      <h2 className="cp-h">Customer stats</h2>
      <dl className="facts cp-facts">
        <dt>Total collected</dt><dd>{formatMoney(s.collectedCents)}</dd>
        <dt>Balance owed</dt><dd>{formatMoney(s.balanceCents)}</dd>
        <dt>Average visit value</dt><dd>{formatMoney(s.averageVisitCents)}</dd>
        <dt>Work orders done</dt><dd>{s.visitsDone}</dd>
        <dt>Past-due invoices</dt><dd className={s.pastDueInvoices ? "bad-text" : undefined}>{s.pastDueInvoices}</dd>
        <dt>Last service</dt><dd>{s.lastService ? fmtDate(s.lastService) : "—"}</dd>
        <dt>Next service</dt><dd>{s.nextService ? fmtDate(s.nextService) : "—"}</dd>
      </dl>
    </div>
  );
}

/** Customer notes (office only), saved straight from the box. */
export function CustomerNotesBox({ customer, onSaved }: { customer: any; onSaved: () => void }) {
  const [text, setText] = useState(customer.notes ?? "");
  const { busy, error, run } = useAction();
  const changed = text !== (customer.notes ?? "");
  return (
    <div className="card stack">
      <div><h2 className="cp-h">Customer notes</h2><span className="muted" style={{ fontSize: 12 }}>For the office. The customer never sees these.</span></div>
      <textarea rows={4} value={text} maxLength={5000} onChange={(e) => setText(e.target.value)} aria-label="Customer notes" />
      <ErrorBox error={error} />
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn primary" disabled={busy || !changed} onClick={() => run(async () => { await api(`/customers/${customer.id}`, { method: "PUT", body: { ...customerBody(customerFormValue(customer)), notes: text } }); onSaved(); })}>Save customer note</button>
      </div>
    </div>
  );
}

/** Call notes (like Homeworks'): tell someone, and make a follow-up to-do. */
export function CallNotes({ customerId, customerName, onSaved }: { customerId: string; customerName: string; onSaved: () => void }) {
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<"call" | "note">("call");
  const [notify, setNotify] = useState(false);
  const [who, setWho] = useState<string[]>([]);
  const [followUp, setFollowUp] = useState(false);
  const [due, setDue] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); });
  const [assignee, setAssignee] = useState("");
  const staff = useApi<any[]>("/employees");
  const people = (staff.data ?? []).filter((e) => !isInactive(e.status));
  const { busy, error, run } = useAction();
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div><h2 className="cp-h">Call notes</h2><span className="muted" style={{ fontSize: 12 }}>For the office. The customer never sees these.</span></div>
        <div className="cal-seg" role="radiogroup" aria-label="Kind">
          {([["call", "Call"], ["note", "Note"]] as const).map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={kind === k} aria-pressed={kind === k} style={{ width: "auto", padding: "0 10px" }} onClick={() => setKind(k)}>{l}</button>)}
        </div>
      </div>
      <textarea rows={3} value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} aria-label="Call note" placeholder={kind === "call" ? "What was the call about?" : "Note"} />
      <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Notify someone</label>
      {notify && (
        <div className="cp-people">
          {people.map((p) => (
            <label key={p.id} className="check"><input type="checkbox" checked={who.includes(p.id)} onChange={(e) => setWho(e.target.checked ? [...who, p.id] : who.filter((x) => x !== p.id))} /> {p.firstName} {p.lastName}</label>
          ))}
        </div>
      )}
      <label className="check"><input type="checkbox" checked={followUp} onChange={(e) => setFollowUp(e.target.checked)} /> Create a follow-up to-do</label>
      {followUp && (
        <div className="formgrid">
          <label>Due<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
          <label>For<select value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">Anyone</option>{people.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}</select></label>
        </div>
      )}
      <ErrorBox error={error} />
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn primary" disabled={busy || !body.trim() || (notify && !who.length)} onClick={() => run(async () => {
          let todoId: string | undefined;
          if (followUp) {
            const t = await api<{ id: string }>("/todos", { body: { title: `Follow up with ${customerName}`, notes: body.trim().slice(0, 2000), date: due, customerId, assigneeIds: assignee ? [assignee] : [] } });
            todoId = t.id;
          }
          await api(`/customers/${customerId}/notes`, { body: { kind, body, notifyIds: notify ? who : [], todoId } });
          setBody(""); setNotify(false); setWho([]); setFollowUp(false);
          onSaved();
        })}>Save {kind === "call" ? "call note" : "note"}</button>
      </div>
    </div>
  );
}

type TimelineItem = { id: string; kind: string; at: string; title: string; body?: string | null; by?: string | null; href?: string | null; tone?: "ok" | "bad" | "warn" | null };
export const TIMELINE_KINDS = [["", "Everything"], ["note", "Notes & calls"], ["email", "Emails"], ["estimate", "Estimates"], ["payment", "Payments"], ["work", "Work orders"], ["account", "Account"]] as const;

/** Everything that happened with the customer, newest first (like Homeworks' Timeline). */
export function Timeline({ customerId, version, kinds, title = "Timeline", filter }: { customerId: string; version: number; kinds?: string; title?: string; filter?: boolean }) {
  const [limit, setLimit] = useState(10);
  const [pick, setPick] = useState(kinds ?? "");
  const data = useApi<TimelineItem[]>(`/customers/${customerId}/timeline?limit=${limit + 1}${pick ? `&kinds=${pick}` : ""}&v=${version}`);
  const items = data.data ?? [];
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="cp-h">{title}</h2>
        {filter && (
          <select value={pick} onChange={(e) => { setPick(e.target.value); setLimit(10); }} aria-label="Show" style={{ width: "auto" }}>
            {TIMELINE_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        )}
      </div>
      {items.length ? (
        <ol className="cp-timeline">
          {items.slice(0, limit).map((i) => (
            <li key={i.id} className={i.tone ?? ""}>
              <div className="cp-tl-head">
                <span className={`badge ${i.tone ?? ""}`}>{TIMELINE_KINDS.find(([k]) => k === i.kind)?.[1].replace(/ &.*/, "") ?? i.kind}</span>
                {i.href ? <Link href={i.href}><strong>{i.title}</strong></Link> : <strong>{i.title}</strong>}
                <span className="muted">{new Date(i.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}{i.by ? ` · ${i.by}` : ""}</span>
              </div>
              {i.body && <div className="cp-tl-body">{i.body}</div>}
            </li>
          ))}
        </ol>
      ) : data.loading ? <p className="muted">Loading…</p> : <Empty>Nothing yet.</Empty>}
      {items.length > limit && <button type="button" className="linkbtn" onClick={() => setLimit(limit + 20)}>Show more</button>}
    </div>
  );
}

/**
 * The customer's work orders (Homeworks calls this box Jobs): one-time ones coming up, recurring series, the
 * packages their properties are on, and history. Add work order asks which type to add.
 */
export function WorkOrdersBox({ customerId }: { customerId: string }) {
  const [tab, setTab] = useState<"upcoming" | "repeating" | "packages" | "history">("upcoming");
  const packages = usePackagesOn({ customerId });
  const open = useApi<{ items: Visit[] }>(`/visits?customerId=${customerId}&status=active`);
  const past = useApi<{ items: Visit[] }>(`/visits?customerId=${customerId}&order=recent&limit=40`);
  const upcoming = (open.data?.items ?? []).filter((v) => !v.seriesId);
  const series = new Map<string, Visit[]>();
  for (const v of open.data?.items ?? []) if (v.seriesId) series.set(v.seriesId, [...(series.get(v.seriesId) ?? []), v]);
  const history = (past.data?.items ?? []).filter((v) => v.status === "completed" || v.status === "skipped");
  const row = (v: Visit, extra?: string) => (
    <tr key={v.id}>
      <td className="nowrap">{v.date ? fmtDate(v.date) : "Waitlist"}</td>
      <td><Link href={`/visits/${v.id}`}>{visitNumber(v.number)}</Link> {v.title}</td>
      <td className="muted">{extra ?? visitWhen(v)}</td>
      <td className="num">{v.totalCents != null ? formatMoney(v.totalCents) : "—"}</td>
    </tr>
  );
  const tabs = [
    ["upcoming", "One time", upcoming.length], ["repeating", "Recurring", series.size],
    // Only for those who can see packages (Customers & billing managers).
    ...(packages.manager ? [["packages", "Packages", packages.current.length] as const] : []),
    ["history", "History", history.length],
  ] as const;
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="cp-h">Work orders</h2>
        <Link className="btn" href={`/visits/new?customerId=${customerId}`} title="Asks what type to add: Waiting List, Package, One Time or Recurring">Add work order</Link>
      </div>
      <div className="cl-stats" role="tablist" aria-label="Work orders" style={{ marginTop: 8 }}>
        {tabs.map(([k, l, n]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l} <b>{n}</b></button>
        ))}
      </div>
      {tab === "packages" ? (
        packages.current.length + packages.past.length > 0 || !packages.loaded ? (
          // Pausing or cancelling a package takes work orders off the waiting list: the other tabs follow.
          <PackageRows on={packages} showProperty onChanged={() => { open.reload(); past.reload(); }} />
        ) : <Empty>No packages. To put one on a property, click Add work order, then Package Work Order.</Empty>
      ) : (
        <div className="tablewrap">
          {tab === "upcoming" && (upcoming.length ? <table><tbody>{upcoming.map((v) => row(v))}</tbody></table> : <Empty>No one time work orders coming up.</Empty>)}
          {tab === "repeating" && (series.size ? (
            <table><tbody>{[...series.values()].map((vs) => row(vs[0], `${vs[0].repeatLabel ?? "Repeats"} · next ${vs[0].date ? fmtDate(vs[0].date) : "—"} · ${vs.length} to go`))}</tbody></table>
          ) : <Empty>No recurring work orders.</Empty>)}
          {tab === "history" && (history.length ? <table><tbody>{history.map((v) => row(v, v.status === "skipped" ? "Skipped" : "Done"))}</tbody></table> : <Empty>Nothing done yet.</Empty>)}
        </div>
      )}
    </div>
  );
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Payments, by month and year (like Homeworks'). */
export function PaymentsBox({ customerId }: { customerId: string }) {
  const now = localToday();
  const [year, setYear] = useState<string>("");
  const [month, setMonth] = useState<string>("");
  const data = useApi<{ years: number[]; rows: any[] }>(`/customers/${customerId}/payments${year ? `?year=${year}${month ? `&month=${month}` : ""}` : ""}`);
  const years = [...new Set([Number(now.slice(0, 4)), ...(data.data?.years ?? [])])].sort((a, b) => b - a);
  const rows = data.data?.rows ?? [];
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="cp-h">Payments</h2>
        <div className="row" style={{ gap: 6 }}>
          <select value={month} disabled={!year} onChange={(e) => setMonth(e.target.value)} aria-label="Month" style={{ width: "auto" }}>
            <option value="">All months</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          <select value={year} onChange={(e) => { setYear(e.target.value); if (!e.target.value) setMonth(""); }} aria-label="Year" style={{ width: "auto" }}>
            <option value="">All years</option>{years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>
      {rows.length ? (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Date</th><th>Invoice</th><th>How</th><th className="num">Amount</th></tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id} className={p.status === "void" ? "muted" : undefined}>
                <td className="nowrap">{fmtDate(p.receivedOn)}</td>
                <td><Link href={`/invoices/${p.invoiceId}`}>{p.invoiceNumber}</Link></td>
                <td>{p.methodDetail ?? p.method}{p.reference ? ` #${p.reference}` : ""}{p.status === "pending" ? " (clearing)" : p.status === "void" ? " (void)" : ""}{p.refundedCents ? ` · ${formatMoney(p.refundedCents)} refunded` : ""}</td>
                <td className="num">{formatMoney(p.amountCents)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Empty>{data.loading ? "Loading…" : "No payments found."}</Empty>}
    </div>
  );
}

/** How they get invoices and estimates (like Homeworks' Communication / Invoice Delivery Preference), changed right here. */
export function DeliveryBox({ customer, onSaved }: { customer: any; onSaved: () => void }) {
  const { busy, error, run } = useAction();
  const toggle = (m: string, on: boolean) => run(async () => {
    const delivery = on ? [...customer.delivery, m] : customer.delivery.filter((x: string) => x !== m);
    if (!delivery.length) throw new Error("Pick at least one way");
    await api(`/customers/${customer.id}`, { method: "PUT", body: { ...customerBody(customerFormValue(customer)), delivery } });
    onSaved();
  });
  return (
    <div className="card">
      <h2 className="cp-h">Invoice delivery preference</h2>
      <div className="row">
        {DELIVERY_METHODS.map((m) => (
          <label key={m} className="check"><input type="checkbox" disabled={busy} checked={customer.delivery.includes(m)} onChange={(e) => toggle(m, e.target.checked)} /> {DELIVERY_LABELS[m]}</label>
        ))}
      </div>
      <ErrorBox error={error} />
    </div>
  );
}

/** The customer's own defaults for invoices and estimates (Homeworks' Invoice Settings and Defaults). */
export function InvoiceDefaultsBox({ customer, onEdit, onSaved }: { customer: any; onEdit: () => void; onSaved: () => void }) {
  const settings = useApi<any>("/invoices/settings").data;
  const [rulesOpen, setRulesOpen] = useState(false);
  const rules = describeCustomerRules(customer, settings ?? undefined);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="cp-h">Invoice settings</h2>
        <button type="button" className="linkbtn" onClick={onEdit}>Change</button>
      </div>
      <dl className="facts cp-facts">
        <dt>Days to pay</dt><dd>{customer.termsDays != null ? `${customer.termsDays} days` : `Your usual terms${settings ? ` (${settings.termsDays} days)` : ""}`}</dd>
        <dt>Discount</dt><dd>{customer.discountPercent ? `${customer.discountPercent}% on new invoices and estimates` : "None"}</dd>
        <dt>Notes on invoices</dt><dd style={{ whiteSpace: "pre-wrap" }}>{customer.invoiceNotes || "—"}</dd>
        <dt>PO number</dt><dd>{customer.poRequired ? "Needed on every invoice" : "Not needed"}</dd>
        <dt>Sales tax</dt><dd>{customer.taxExempt ? `Exempt${customer.taxExemptNumber ? ` (${customer.taxExemptNumber})` : ""}` : customer.taxRate != null ? `${customer.taxRate}%` : "The usual rate"}</dd>
        <dt>Autopay</dt><dd>{customer.autopay ? "On (see Cards & bank accounts)" : "Off"}</dd>
        {settings?.autoApplyCredits !== undefined && <><dt>Credit</dt><dd>{settings.autoApplyCredits ? "Used on new invoices automatically" : "Applied by hand"}</dd></>}
        <dt>Late fees</dt><dd>{rules.lateFees}</dd>
        <dt>Auto-send</dt><dd>{rules.autoSend}</dd>
      </dl>
      {rulesOpen
        ? <CustomerBillingRules customer={customer} onCancel={() => setRulesOpen(false)} onSaved={() => { setRulesOpen(false); onSaved(); }} />
        : <button type="button" className="linkbtn" onClick={() => setRulesOpen(true)}>Change late fees or auto-send</button>}
    </div>
  );
}

/** Who can sign in to the portal, and seeing it as they do. */
export function PortalBox({ customer, onViewAs, busy }: { customer: any; onViewAs: () => void; busy: boolean }) {
  const emails = [customer.email, ...customer.contacts.filter((k: any) => k.email).map((k: any) => `${k.email} (${k.name})`)].filter(Boolean);
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="cp-h">Customer portal</h2>
        <button type="button" className="btn" disabled={busy} onClick={onViewAs}>View as customer</button>
      </div>
      <p className="muted" style={{ margin: "6px 0" }}>They sign in with a code emailed to {emails.length > 1 ? "any of these" : "this address"}; there&apos;s no password.</p>
      {emails.length ? <ul className="plain-list">{emails.map((e) => <li key={e}>{e}</li>)}</ul> : <p className="bad-text" style={{ margin: 0 }}>No email on file, so they can&apos;t sign in yet.</p>}
    </div>
  );
}

/** "Record payment": pick one of their open invoices. */
export function PayPicker({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const list = useApi<{ rows: any[] }>(`/invoices?status=all&customerId=${customerId}&limit=50`);
  const open = (list.data?.rows ?? []).filter((r) => (r.status === "sent" || r.status === "partial") && r.balanceCents > 0);
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}><h2 className="cp-h">Record a payment</h2><button type="button" className="btn" onClick={onClose} aria-label="Close">✕</button></div>
      {open.length ? (
        <ul className="plain-list">
          {open.map((r) => <li key={r.id}><Link href={`/invoices/${r.id}?pay=1`}>Invoice {r.number}</Link> <span className="muted">· {formatMoney(r.balanceCents)} owed · due {fmtDate(r.dueDate)}</span></li>)}
        </ul>
      ) : <p className="muted" style={{ margin: 0 }}>{list.loading ? "Loading…" : "Nothing is owed. To take money ahead of time, add a prepayment below."}</p>}
    </div>
  );
}

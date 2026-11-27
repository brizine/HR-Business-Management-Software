"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ESTIMATE_STATUS_LABELS, INVOICE_STATUS_LABELS, PAYMENT_METHOD_LABELS, VISIT_STATUS_LABELS, formatMoney, type PaymentMethod } from "@crewdesk/shared";
import { fmtDate } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { ErrorBox, PageHead } from "@/components/ui";

/** Date ranges like Homeworks' Job Stats picker (weeks start on Sunday). */
const PRESETS = [
  ["today", "Today"], ["yesterday", "Yesterday"], ["thisWeek", "This week"], ["lastWeek", "Last week"], ["weekToDate", "This week to date"],
  ["last7", "Last 7 days"], ["last30", "Last 30 days"], ["last60", "Last 60 days"], ["last90", "Last 90 days"],
  ["thisMonth", "This month"], ["monthToDate", "This month to date"], ["lastMonth", "Last month"],
  ["thisYear", "This year"], ["yearToDate", "This year to date"], ["lastYear", "Last year"], ["custom", "Custom range"],
] as const;
type Preset = (typeof PRESETS)[number][0];
const add = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dow = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const monthEnd = (d: string) => add(monthStart(add(monthStart(d), 32)), -1);
function rangeFor(p: Preset, today: string): [string, string] {
  const sun = add(today, -dow(today));
  switch (p) {
    case "today": return [today, today];
    case "yesterday": return [add(today, -1), add(today, -1)];
    case "thisWeek": return [sun, add(sun, 6)];
    case "lastWeek": return [add(sun, -7), add(sun, -1)];
    case "weekToDate": return [sun, today];
    case "last7": return [add(today, -6), today];
    case "last30": return [add(today, -29), today];
    case "last60": return [add(today, -59), today];
    case "last90": return [add(today, -89), today];
    case "thisMonth": return [monthStart(today), monthEnd(today)];
    case "monthToDate": return [monthStart(today), today];
    case "lastMonth": { const lm = add(monthStart(today), -1); return [monthStart(lm), lm]; }
    case "thisYear": return [`${today.slice(0, 4)}-01-01`, `${today.slice(0, 4)}-12-31`];
    case "yearToDate": return [`${today.slice(0, 4)}-01-01`, today];
    case "lastYear": { const y = Number(today.slice(0, 4)) - 1; return [`${y}-01-01`, `${y}-12-31`]; }
    case "custom": return [today, today];
  }
}

type Who = { id: string; name: string } | null;
type Data = {
  today: string; from: string; to: string;
  standing: { pastDueCents: number; outstandingCents: number; creditCents: number; paidCents: number };
  jobs: { total: number; notStarted: number; inProgress: number; completed: number; skipped: number };
  review: { total: number; rows: { id: string; at: string; automation: string; step: string; customer: Who }[] };
  todos: { overdue: number; rows: { id: string; title: string; date: string; startTime: string | null; color: string; customer: Who; people: string[] }[] };
  visits: { total: number; rows: { id: string; title: string; status: keyof typeof VISIT_STATUS_LABELS; startTime: string | null; crew: string | null; customer: Who }[] };
  payments: { id: string; amountCents: number; method: PaymentMethod; methodDetail: string | null; receivedOn: string; status: string; invoiceId: string; invoiceNumber: number | null; customer: Who }[];
  invoices: { id: string; number: number | null; status: keyof typeof INVOICE_STATUS_LABELS; totalCents: number; balanceCents: number; dueDate: string; overdue: boolean; customer: Who }[];
  estimates: { id: string; number: number; title: string | null; status: keyof typeof ESTIMATE_STATUS_LABELS; totalCents: number; expired: boolean; customer: Who }[];
  unreadTexts: number;
  waiting: {
    count: number; totalCents: number; notSeen: number; expiringSoon: number;
    rows: { id: string; number: number; title: string | null; status: string; totalCents: number; validUntil: string | null; sentAt: string | null; seen: boolean; daysLeft: number | null; customer: Who }[];
  };
};

const time12 = (t: string | null) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const longToday = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** My Day, like Homeworks': account standing, job stats for a range, and what needs attention. */
export default function MyDay() {
  const { me } = useAuth();
  const [preset, setPreset] = useState<Preset>("today");
  const [range, setRange] = useState<[string, string] | null>(null);
  const day = useApi<Data>(`/my-day${range ? `?from=${range[0]}&to=${range[1]}` : ""}`);
  const d = day.data;
  // Remember the range picked (this browser).
  useEffect(() => {
    try { const p = localStorage.getItem("crewdesk.myday-range") as Preset | null; if (p && p !== "today" && p !== "custom" && PRESETS.some(([k]) => k === p)) setPreset(p); } catch { /* private mode */ }
  }, []);
  useEffect(() => { if (d && preset !== "custom" && !range) setRange(rangeFor(preset, d.today)); }, [d, preset, range]);
  const pick = (p: Preset) => {
    setPreset(p);
    try { localStorage.setItem("crewdesk.myday-range", p); } catch { /* private mode */ }
    if (d && p !== "custom") setRange(rangeFor(p, d.today));
  };
  const [from, to] = range ?? [d?.from ?? "", d?.to ?? ""];
  const oneDay = from === to;
  const jobLink = (view: string) => (oneDay ? `/calendar?v=day&d=${from}` : `/visits?view=${view}`);
  const jobTip = oneDay ? "Open this day's work orders on the calendar" : "Open these work orders in the list";

  return (
    <div className="myday">
      <PageHead title="My Day" sub={d ? longToday(d.today) : "Loading…"} />
      <ErrorBox error={day.error} />
      {d && (
        <>
          <h2 className="myday-h">Account standing</h2>
          <div className="myday-tiles">
            <Tile href="/invoices?status=overdue" label="Past due" value={formatMoney(d.standing.pastDueCents)} tone="bad" hint="Past their due date" tip="Open the invoices that are past their due date" />
            <Tile href="/invoices?status=open" label="Outstanding" value={formatMoney(d.standing.outstandingCents)} tone="info" hint="Owed, not yet due" tip="Open the invoices that are owed but not yet due" />
            <Tile href="/customers" label="Credit" value={formatMoney(d.standing.creditCents)} tone="warn" hint="On customers' accounts" tip="Open Customers: credit sits on each customer's account" />
            <Tile href="/invoices?status=paid" label="Paid" value={formatMoney(d.standing.paidCents)} tone="ok" hint={oneDay ? (from === d.today ? "Today" : fmtDate(from)) : `${fmtDate(from)} – ${fmtDate(to)}`} tip="Open the paid invoices" />
          </div>

          <div className="row myday-hrow">
            <h2 className="myday-h">Job stats</h2>
            <div className="row" style={{ gap: 6 }}>
              <select value={preset} onChange={(e) => pick(e.target.value as Preset)} aria-label="Date range" style={{ width: "auto" }}>
                {PRESETS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              {preset === "custom" && (
                <>
                  <input type="date" value={from} onChange={(e) => e.target.value && setRange([e.target.value, to < e.target.value ? e.target.value : to])} aria-label="From" />
                  <span className="muted">to</span>
                  <input type="date" value={to} min={from} onChange={(e) => e.target.value && setRange([from, e.target.value])} aria-label="To" />
                </>
              )}
              {preset !== "custom" && <span className="muted" style={{ fontSize: 13 }}>{oneDay ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`}</span>}
            </div>
          </div>
          <div className="myday-tiles">
            <Tile href={jobLink("all")} label="Total jobs" value={String(d.jobs.total)} tone="bad" hint={d.jobs.skipped ? `${d.jobs.skipped} skipped not counted` : undefined} tip={jobTip} />
            <Tile href={jobLink("upcoming")} label="Yet to start" value={String(d.jobs.notStarted)} tone="info" tip={jobTip} />
            <Tile href={jobLink("upcoming")} label="In progress" value={String(d.jobs.inProgress)} tone="warn" tip={jobTip} />
            <Tile href={jobLink("completed")} label="Completed" value={String(d.jobs.completed)} tone="ok" tip={jobTip} />
          </div>

          <div className="myday-cols">
            <div className="myday-col">
              <Box title="Automations in review" more={["/automations?tab=review", "See all automations"]} count={d.review.total}>
                {d.review.rows.map((r) => (
                  <li key={r.id}><span><strong>{r.automation}</strong> · {r.step}</span><span className="muted">{r.customer ? <Link href={`/customers/${r.customer.id}`}>{r.customer.name}</Link> : ""}</span></li>
                ))}
              </Box>
              <Box title="Upcoming to-dos" more={["/todos", "See all to-dos"]} note={d.todos.overdue ? <Link href="/todos" className="bad-text">{d.todos.overdue} overdue</Link> : null}>
                {d.todos.rows.map((t) => (
                  <li key={t.id}>
                    <span><span className="myday-dot" style={{ background: t.color }} /> <Link href={`/todos/${t.id}`}><strong>{t.title}</strong></Link>{t.customer && <> · <Link href={`/customers/${t.customer.id}`}>{t.customer.name}</Link></>}</span>
                    <span className="muted">{t.date === d.today ? "Today" : fmtDate(t.date)}{t.startTime ? ` ${time12(t.startTime)}` : ""}{t.people.length ? ` · ${t.people.join(", ")}` : ""}</span>
                  </li>
                ))}
              </Box>
              <Box title="Today's work orders" more={[`/calendar?v=day&d=${d.today}`, "See the calendar"]} count={d.visits.total}>
                {d.visits.rows.map((v) => (
                  <li key={v.id}>
                    <span><Link href={`/visits/${v.id}`}><strong>{v.title}</strong></Link>{v.customer && <> · {v.customer.name}</>}</span>
                    <span className="muted">{v.startTime ? `${time12(v.startTime)} · ` : ""}{v.crew ? `${v.crew} · ` : ""}<span className={`badge ${v.status === "completed" ? "ok" : v.status === "on_site" ? "warn" : v.status === "skipped" ? "" : "info"}`}>{VISIT_STATUS_LABELS[v.status]}</span></span>
                  </li>
                ))}
              </Box>
              <Box title="Estimates waiting on an answer" more={["/estimates?status=open", "See all waiting"]} count={d.waiting.count}
                note={d.waiting.count ? <span className="muted">{formatMoney(d.waiting.totalCents)}{d.waiting.expiringSoon ? <> · <span className="warn-text">{d.waiting.expiringSoon} run out this week</span></> : ""}{d.waiting.notSeen ? ` · ${d.waiting.notSeen} not opened yet` : ""}</span> : null}>
                {d.waiting.rows.map((e) => (
                  <li key={e.id}>
                    <span><Link href={`/estimates/${e.id}`}><strong>Estimate {e.number}</strong></Link>{e.title ? ` · ${e.title}` : ""}{e.customer && <> · {e.customer.name}</>}</span>
                    <span className="muted">
                      {formatMoney(e.totalCents)}
                      {e.daysLeft != null ? <> · <span className={e.daysLeft <= 7 ? "warn-text" : ""}>{e.daysLeft === 0 ? "runs out today" : `runs out in ${e.daysLeft} day${e.daysLeft === 1 ? "" : "s"}`}</span></> : e.sentAt ? ` · sent ${fmtDate(e.sentAt.slice(0, 10))}` : ""}
                      {e.status === "changes" ? <> · <span className="badge warn">changes asked</span></> : !e.seen ? <> · <span className="badge">not opened</span></> : null}
                    </span>
                  </li>
                ))}
              </Box>
            </div>
            <div className="myday-col">
              {d.unreadTexts > 0 && <Link href="/texts" className="card myday-alert">💬 {d.unreadTexts} unread text{d.unreadTexts === 1 ? "" : "s"} from customers</Link>}
              <Box title="Recent payments" more={["/invoices?status=paid", "See paid invoices"]}>
                {d.payments.map((p) => (
                  <li key={p.id}>
                    <span><strong>{formatMoney(p.amountCents)}</strong> {PAYMENT_METHOD_LABELS[p.method] ?? p.method}{p.methodDetail ? ` (${p.methodDetail})` : ""}{p.status === "pending" && <> <span className="badge warn">clearing</span></>}{p.customer && <> · {p.customer.name}</>}</span>
                    <span className="muted">{fmtDate(p.receivedOn)}{p.invoiceNumber ? <> · <Link href={`/invoices/${p.invoiceId}`}>Invoice {p.invoiceNumber}</Link></> : ""}</span>
                  </li>
                ))}
              </Box>
              <Box title="Invoices" more={["/invoices", "See all invoices"]}>
                {d.invoices.map((i) => (
                  <li key={i.id}>
                    <span><Link href={`/invoices/${i.id}`}><strong>{i.number ? `Invoice ${i.number}` : "Draft"}</strong></Link>{i.customer && <> · {i.customer.name}</>}</span>
                    <span className="muted">{formatMoney(i.totalCents)}{i.balanceCents > 0 && i.status !== "draft" ? ` · ${formatMoney(i.balanceCents)} owed` : ""} · <span className={`badge ${i.overdue ? "bad" : i.status === "paid" ? "ok" : i.status === "draft" ? "" : "info"}`}>{i.overdue ? "Past due" : INVOICE_STATUS_LABELS[i.status]}</span></span>
                  </li>
                ))}
              </Box>
              <Box title="Estimates" more={["/estimates", "See all estimates"]}>
                {d.estimates.map((e) => (
                  <li key={e.id}>
                    <span><Link href={`/estimates/${e.id}`}><strong>Estimate {e.number}</strong></Link>{e.title ? ` · ${e.title}` : ""}{e.customer && <> · {e.customer.name}</>}</span>
                    <span className="muted">{formatMoney(e.totalCents)} · <span className={`badge ${e.status === "accepted" ? "ok" : e.status === "declined" ? "bad" : e.expired ? "warn" : "info"}`}>{e.expired ? "Expired" : ESTIMATE_STATUS_LABELS[e.status]}</span></span>
                  </li>
                ))}
              </Box>
              {me?.access?.chemicalTracking && <ChemicalBox />}
              <EmailHealthBox />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ href, label, value, tone, hint, tip }: { href: string; label: string; value: string; tone: "bad" | "info" | "warn" | "ok"; hint?: string; tip?: string }) {
  return (
    <Link href={href} className={`card myday-tile ${tone}`} data-tip={tip}>
      <span className="l">{label}</span>
      <span className="v">{value}</span>
      {hint && <span className="h">{hint}</span>}
    </Link>
  );
}

function Box({ title, more, count, note, children }: { title: string; more: [string, string]; count?: number; note?: React.ReactNode; children: React.ReactNode[] }) {
  const items = children.filter(Boolean);
  return (
    <section className="myday-box">
      <div className="row myday-boxhead">
        <h2>{title}{count ? <span className="badge" style={{ marginLeft: 6 }}>{count}</span> : null}{note ? <span style={{ marginLeft: 8, fontSize: 13, fontWeight: 400 }}>{note}</span> : null}</h2>
        <Link href={more[0]}>{more[1]}</Link>
      </div>
      <div className="card myday-list">{items.length ? <ul className="plain-list">{items}</ul> : <p className="muted myday-empty">No records found</p>}</div>
    </section>
  );
}

type Attention = {
  records: { count: number; rows: { id: string; appliedOn: string; customerName: string; issues: string[] }[] };
  certs: { id: string; name: string; certNo: string; expiresOn: string; expired: boolean }[];
  notices: { toPrint: number; failed: number };
};

/** Chemical Tracking (for the people who can open it): records missing something, notices to print, certifications running out. */
function ChemicalBox() {
  const a = useApi<Attention>("/chemical-tracking/attention");
  const d = a.data;
  if (!d) return null;
  const items = [
    ...d.records.rows.map((r) => (
      <li key={r.id}>
        <span><Link href={`/chemical-tracking/records/${r.id}`}><strong>{r.customerName}</strong></Link> · {fmtDate(r.appliedOn)}</span>
        <span className="muted">{r.issues[0]}{r.issues.length > 1 ? ` (+${r.issues.length - 1} more)` : ""}</span>
      </li>
    )),
    ...d.certs.map((c) => (
      <li key={c.id}>
        <span><Link href="/chemical-tracking/applicators"><strong>{c.name}</strong></Link> · certification {c.certNo}</span>
        <span className={c.expired ? "bad-text" : "warn-text"}>{c.expired ? "expired" : "expires"} {fmtDate(c.expiresOn)}</span>
      </li>
    )),
    d.notices.toPrint ? <li key="print"><span><Link href="/chemical-tracking/notices?show=to_print"><strong>{d.notices.toPrint} customer notice{d.notices.toPrint === 1 ? "" : "s"}</strong></Link> waiting to print</span></li> : null,
    d.notices.failed ? <li key="failed"><span><Link href="/chemical-tracking/notices"><strong>{d.notices.failed} customer notice{d.notices.failed === 1 ? "" : "s"}</strong></Link> didn&apos;t send</span></li> : null,
  ];
  return (
    <Box title="Chemical Tracking" more={["/chemical-tracking?status=issues", "See records"]} count={d.records.count + d.certs.length + d.notices.toPrint + d.notices.failed}
      note={d.records.count > d.records.rows.length ? <span className="muted">{d.records.count} records need attention</span> : null}>
      {items}
    </Box>
  );
}

type Health = {
  setup: { configured: boolean; from: string | null; host: string | null; replyDomain: string | null; mismatch: boolean };
  domain: null | {
    domain: string;
    spf: { status: "ok" | "missing" | "too_many" | "unknown"; record: string | null; softOnly: boolean };
    dkim: { status: "ok" | "not_found" | "unknown"; selector: string | null };
    dmarc: { status: "ok" | "missing" | "unknown"; policy: string | null; record: string | null };
  };
  last30: { sent: number; failed: number; failures: { email: string; error: string | null; at: string; subject: string; customer: Who }[] };
  addresses: { customers: number; withEmail: number; noEmail: number; unsubscribed: number; problemCount: number; problems: { customerId: string; name: string; email: string; problem: string }[] };
  status: "off" | "good" | "check" | "attention";
  dnsChecked: boolean;
};
const HEALTH: Record<Health["status"], [string, string]> = { good: ["Looks good", "ok"], check: ["Worth a look", "warn"], attention: ["Needs attention", "bad"], off: ["Email isn't set up", "bad"] };

/** Email deliverability: is mail set up to land in inboxes, did it go, and which customers can't get it. */
function EmailHealthBox() {
  const h = useApi<Health>("/my-day/email");
  const [all, setAll] = useState(false);
  const d = h.data;
  const mark = (ok: boolean | null) => <span className={ok ? "ok-text" : ok === false ? "bad-text" : "muted"} aria-hidden>{ok ? "✓" : ok === false ? "✗" : "?"}</span>;
  return (
    <section className="myday-box">
      <div className="row myday-boxhead">
        <h2>Email deliverability{d && <span className={`badge ${HEALTH[d.status][1]}`} style={{ marginLeft: 6 }}>{HEALTH[d.status][0]}</span>}</h2>
        <Link href="/help#email-deliverability">How to improve it</Link>
      </div>
      <div className="card myday-health">
        {h.error && <ErrorBox error={h.error} />}
        {!d && !h.error && <p className="muted" style={{ margin: 0 }}>Checking…</p>}
        {d && (
          <>
            {d.setup.configured ? (
              <p className="muted" style={{ margin: 0 }}>Sending from <strong>{d.setup.from ?? "?"}</strong>{d.setup.host ? <> through {d.setup.host}</> : null}.</p>
            ) : <p className="bad-text" style={{ margin: 0 }}>Email isn&apos;t set up on the server, so nothing is being sent.</p>}
            {!d.dnsChecked && <p className="warn-text" style={{ margin: 0, fontSize: 13 }}>The server couldn&apos;t look up DNS records just now, so the domain and address checks were skipped. They run again within the hour.</p>}
            {d.domain && d.dnsChecked && (
              <ul className="plain-list myday-checks">
                <li>{mark(d.domain.spf.status === "ok" ? true : d.domain.spf.status === "unknown" ? null : false)} <strong>SPF</strong> <span className="muted">
                  {d.domain.spf.status === "ok" ? `says which servers may send for ${d.domain.domain}${d.domain.spf.softOnly ? " (but doesn't end in ~all or -all)" : ""}`
                    : d.domain.spf.status === "too_many" ? `${d.domain.domain} has more than one SPF record; there must be exactly one`
                    : d.domain.spf.status === "missing" ? `${d.domain.domain} has no SPF record, so inboxes can't tell your mail is really yours`
                    : "couldn't be checked right now"}</span></li>
                <li>{mark(d.domain.dkim.status === "ok" ? true : d.domain.dkim.status === "unknown" ? null : false)} <strong>DKIM</strong> <span className="muted">
                  {d.domain.dkim.status === "ok" ? `signing key found (${d.domain.dkim.selector})` : d.domain.dkim.status === "not_found" ? "no signing key found under the usual names; your mail service tells you the record to add" : "couldn't be checked right now"}</span></li>
                <li>{mark(d.domain.dmarc.status === "ok" ? true : d.domain.dmarc.status === "unknown" ? null : false)} <strong>DMARC</strong> <span className="muted">
                  {d.domain.dmarc.status === "ok" ? `policy: ${d.domain.dmarc.policy ?? "?"}${d.domain.dmarc.policy === "none" ? " (watching only)" : ""}` : d.domain.dmarc.status === "missing" ? "missing; Gmail and Yahoo expect it from businesses that email customers" : "couldn't be checked right now"}</span></li>
              </ul>
            )}
            {d.setup.mismatch && <p className="warn-text" style={{ margin: 0, fontSize: 13 }}>Replies go to @{d.setup.replyDomain}, but mail is sent from @{d.domain?.domain}. That's fine, but the sending domain is the one that needs the records above.</p>}
            <p style={{ margin: 0 }}><strong>Last 30 days:</strong> {d.last30.sent} email{d.last30.sent === 1 ? "" : "s"} to customers went out{d.last30.failed ? <>, <span className="bad-text">{d.last30.failed} didn&apos;t</span></> : ""}.</p>
            {d.last30.failures.length > 0 && (
              <ul className="plain-list myday-sub">
                {d.last30.failures.map((f, i) => (
                  <li key={i}>{f.customer ? <Link href={`/customers/${f.customer.id}`}>{f.customer.name}</Link> : f.email} <span className="muted">· {f.subject} · {fmtDate(f.at.slice(0, 10))} · {(f.error ?? "").slice(0, 120)}</span></li>
                ))}
              </ul>
            )}
            <p style={{ margin: 0 }}>
              <strong>Customer addresses:</strong> {d.addresses.withEmail} of {d.addresses.customers} active customers have an email.
              {d.addresses.problemCount ? <> <span className="bad-text">{d.addresses.problemCount} can&apos;t get email.</span></> : " None look wrong."}
              {d.addresses.unsubscribed ? ` ${d.addresses.unsubscribed} unsubscribed (they still get invoices and receipts).` : ""}
              {d.addresses.noEmail ? ` ${d.addresses.noEmail} get invoices by email but have no address.` : ""}
            </p>
            {d.addresses.problems.length > 0 && (
              <ul className="plain-list myday-sub">
                {(all ? d.addresses.problems : d.addresses.problems.slice(0, 5)).map((p) => (
                  <li key={p.customerId}><Link href={`/customers/${p.customerId}`}>{p.name}</Link> <span className="muted">· {p.email} · {p.problem}</span></li>
                ))}
                {d.addresses.problems.length > 5 && <li><button type="button" className="linkbtn" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${d.addresses.problems.length}`}</button></li>}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}

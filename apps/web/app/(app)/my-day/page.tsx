"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ESTIMATE_STATUS_LABELS, INVOICE_STATUS_LABELS, PAYMENT_METHOD_LABELS, VISIT_STATUS_LABELS, formatMoney, type PaymentMethod } from "@crewdesk/shared";
import { fmtDate } from "@/lib/api";
import { useApi } from "@/lib/hooks";
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
};

const time12 = (t: string | null) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const longToday = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** My Day, like Homeworks': account standing, job stats for a range, and what needs attention. */
export default function MyDay() {
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

  return (
    <div className="myday">
      <PageHead title="My Day" sub={d ? longToday(d.today) : "Loading…"} />
      <ErrorBox error={day.error} />
      {d && (
        <>
          <h2 className="myday-h">Account standing</h2>
          <div className="myday-tiles">
            <Tile href="/invoices?status=overdue" label="Past due" value={formatMoney(d.standing.pastDueCents)} tone="bad" hint="Past their due date" />
            <Tile href="/invoices?status=open" label="Outstanding" value={formatMoney(d.standing.outstandingCents)} tone="info" hint="Owed, not yet due" />
            <Tile href="/customers" label="Credit" value={formatMoney(d.standing.creditCents)} tone="warn" hint="On customers' accounts" />
            <Tile href="/invoices?status=paid" label="Paid" value={formatMoney(d.standing.paidCents)} tone="ok" hint={oneDay ? (from === d.today ? "Today" : fmtDate(from)) : `${fmtDate(from)} – ${fmtDate(to)}`} />
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
            <Tile href={jobLink("all")} label="Total jobs" value={String(d.jobs.total)} tone="bad" hint={d.jobs.skipped ? `${d.jobs.skipped} skipped not counted` : undefined} />
            <Tile href={jobLink("upcoming")} label="Yet to start" value={String(d.jobs.notStarted)} tone="info" />
            <Tile href={jobLink("upcoming")} label="In progress" value={String(d.jobs.inProgress)} tone="warn" />
            <Tile href={jobLink("completed")} label="Completed" value={String(d.jobs.completed)} tone="ok" />
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
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ href, label, value, tone, hint }: { href: string; label: string; value: string; tone: "bad" | "info" | "warn" | "ok"; hint?: string }) {
  return (
    <Link href={href} className={`card myday-tile ${tone}`}>
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

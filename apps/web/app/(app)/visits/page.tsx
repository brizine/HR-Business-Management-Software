"use client";
import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { formatMoney, isInactive, visitNumber } from "@crewdesk/shared";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { VisitStatus, crewNames, visitWhen, type Visit } from "@/components/visits";

const VIEWS = [
  ["upcoming", "Coming up (open)"], ["waitlist", "Waitlist (no date)"], ["invoice", "Ready to invoice"],
  ["completed", "Completed"], ["skipped", "Skipped"], ["all", "All"],
] as const;
type View = (typeof VIEWS)[number][0];
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function WorkOrders() {
  const { me, can } = useAuth();
  const manager = can("manager", "customers");
  const [view, setView] = useState<View>("upcoming");
  const [who, setWho] = useState(manager ? "all" : "mine");
  const [crewF, setCrewF] = useState("");
  // From a crew's card on the Crews page (?crew=…).
  useEffect(() => { const c = new URL(window.location.href).searchParams.get("crew"); if (c) setCrewF(c); }, []);
  const crews = useApi<{ id: string; name: string }[]>("/crews?all=1");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => { const t = setTimeout(() => setQuery(q), 250); return () => clearTimeout(t); }, [q]);
  const [picked, setPicked] = useState<string[]>([]);
  const [notice, setNotice] = useState<React.ReactNode>(null);
  const invoice = useAction();
  const path = useMemo(() => {
    const p = new URLSearchParams();
    if (view === "upcoming") p.set("status", "active");
    if (view === "waitlist") p.set("waitlist", "true");
    if (view === "invoice") p.set("invoiceable", "true");
    if (view === "completed" || view === "skipped") { p.set("status", view); p.set("order", "recent"); }
    if (view === "all") p.set("order", "recent");
    if (who === "mine") p.set("mine", "true"); else if (who !== "all") p.set("assigneeId", who);
    if (crewF) p.set("crewId", crewF);
    if (query.trim()) p.set("q", query.trim());
    return `/visits?${p}`;
  }, [view, who, query, crewF]);
  const list = useApi<{ today: string; items: Visit[]; more: boolean }>(path);
  const staff = useApi<any[]>(manager ? "/employees" : null);
  useEffect(() => { setPicked([]); }, [path]);
  const items = list.data?.items ?? [];
  const today = list.data?.today ?? "";
  const total = items.reduce((s, v) => s + (v.totalCents ?? 0), 0);
  const overdue = (v: Visit) => v.status === "open" && !!v.date && !!today && (v.endDate ?? v.date) < today;

  return (
    <>
      <PageHead title="Work orders" sub={list.data ? `${items.length}${list.data.more ? "+" : ""} shown${manager && total ? ` · ${formatMoney(total)}` : ""}` : undefined}>
        <Link className="btn" href="/calendar">Calendar</Link>
        {manager && <Link className="btn primary" href="/visits/new">New work order</Link>}
      </PageHead>
      {notice && <div className="notice" role="status">{notice} <button type="button" className="linkbtn" onClick={() => setNotice(null)}>OK</button></div>}
      <div className="card filters">
        <label>Show
          <select value={view} onChange={(e) => setView(e.target.value as View)}>
            {VIEWS.filter(([k]) => manager || k !== "invoice").map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        {manager && (
          <label>Person
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="all">Everyone</option><option value="mine">Me</option><option value="none">No crew yet</option>
              {(staff.data ?? []).filter((e) => !isInactive(e.status) && e.id !== me?.user.id).map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
            </select>
          </label>
        )}
        {!!crews.data?.length && (
          <label>Crew
            <select value={crewF} onChange={(e) => setCrewF(e.target.value)}>
              <option value="">Any crew</option><option value="none">No crew</option>
              {crews.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <label>Search<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="WO number, title, notes" /></label>
      </div>
      <ErrorBox error={list.error || invoice.error} />
      {view === "invoice" && items.length > 0 && (
        <div className="card row" style={{ justifyContent: "space-between" }}>
          <span>{picked.length ? `${picked.length} picked · ${formatMoney(items.filter((v) => picked.includes(v.id)).reduce((s, v) => s + (v.totalCents ?? 0), 0))}` : "Pick the work orders to invoice (one draft invoice per customer and property)."}</span>
          <span className="row">
            <button type="button" className="btn" onClick={() => setPicked(picked.length === items.length ? [] : items.map((v) => v.id))}>{picked.length === items.length ? "Pick none" : "Pick all"}</button>
            <button type="button" className="btn primary" disabled={!picked.length || invoice.busy} onClick={() => invoice.run(async () => {
              const r = await api<{ invoices: { id: string }[]; summary: string }>("/visits/invoice", { body: { ids: picked } });
              setNotice(<>Made {r.summary}. <Link href={r.invoices.length === 1 ? `/invoices/${r.invoices[0].id}` : "/invoices?status=draft"}>Review and send {r.invoices.length === 1 ? "it" : "them"}</Link></>);
              list.reload();
            })}>Create invoices</button>
          </span>
        </div>
      )}
      <div className="card">
        {items.length ? (
          <div className="tablewrap">
            <table className="visit-table">
              <thead><tr>{view === "invoice" && <th style={{ width: 30 }} />}<th>#</th><th>When</th><th>Customer · property</th><th>Work order</th><th>Crew</th>{manager && <th style={{ textAlign: "right" }}>Total</th>}<th>Status</th></tr></thead>
              <tbody>{items.map((v) => (
                <tr key={v.id} className={overdue(v) ? "overdue-row" : undefined}>
                  {view === "invoice" && <td><input type="checkbox" aria-label={`Pick ${visitNumber(v.number)}`} checked={picked.includes(v.id)} onChange={() => setPicked((p) => (p.includes(v.id) ? p.filter((x) => x !== v.id) : [...p, v.id]))} /></td>}
                  <td><span className="visit-dot" style={{ background: v.color }} /><Link href={`/visits/${v.id}`}>{visitNumber(v.number)}</Link></td>
                  <td>{visitWhen(v)}{overdue(v) && <div><span className="badge bad">overdue</span></div>}</td>
                  <td>{v.customer.name}<div className="muted" style={{ fontSize: 13 }}>{v.property?.address ?? v.location ?? ""}</div></td>
                  <td><Link href={`/visits/${v.id}`}>{v.title}</Link>{v.seriesId && <span className="todo-repeat" title={v.repeatLabel ?? "Repeats"}> ↻</span>}</td>
                  <td>{v.crew && <span className="visit-dot" style={{ background: v.crew.color }} />}{crewNames(v) || <span className="muted">No crew</span>}</td>
                  {manager && <td style={{ textAlign: "right" }}>{v.billing === "invoice" ? formatMoney(v.totalCents) : <span className="muted">No charge</span>}</td>}
                  <td><VisitStatus v={v} />{v.invoiced && <div><Link className="muted" style={{ fontSize: 12 }} href={`/invoices/${v.invoice!.id}`}>{v.invoice!.number ? `Invoice ${v.invoice!.number}` : "Draft invoice"}</Link></div>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : list.data ? <Empty>{view === "invoice" ? "Nothing waiting to be invoiced." : view === "waitlist" ? "Nothing on the waitlist." : "No work orders here."}</Empty> : null}
      </div>
      {list.data?.more && <p className="muted">Showing the first {items.length}. Narrow it down with the filters.</p>}
      {today && view === "upcoming" && <p className="muted">Tip: the <Link href={`/calendar?v=week&d=${plusDays(today, 0)}`}>Calendar</Link> shows these by day, with drag and drop.</p>}
    </>
  );
}

export default function Page() {
  return <Suspense><WorkOrders /></Suspense>;
}

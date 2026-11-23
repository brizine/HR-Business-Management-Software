"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatMoney } from "@crewdesk/shared";
import { API_URL, api, fmtDate } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { InvoiceStatus } from "@/components/invoices";

const TABS = [["open", "Open"], ["overdue", "Overdue"], ["draft", "Drafts"], ["mail", "To mail"], ["paid", "Paid"], ["void", "Void"], ["all", "All"]] as const;

export default function Invoices() {
  const [status, setStatus] = useState<string>("open");
  // From My Day's tiles: /invoices?status=overdue (or open, paid…).
  useEffect(() => { const st = new URL(window.location.href).searchParams.get("status"); if (st && ["open", "overdue", "draft", "paid", "void", "mail", "all"].includes(st)) setStatus(st); }, []);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => { const t = setTimeout(() => setQuery(q), 250); return () => clearTimeout(t); }, [q]);
  // Open on a tab from a link (e.g. ?status=mail).
  useEffect(() => { const s = new URLSearchParams(window.location.search).get("status"); if (s) setStatus(s); }, []);
  const list = useApi<{ total: number; dueCents: number; rows: any[] }>(`/invoices?status=${status}${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ""}`);
  const mailCount = useApi<string[]>("/invoices/print-queue");
  const mailing = useAction();
  useEffect(() => { setPicked(status === "mail" ? (list.data?.rows ?? []).map((r) => r.id) : []); }, [status, list.data]);
  const rows = list.data?.rows ?? [];
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <>
      <PageHead title="Invoices" sub={<span role="status">{list.data ? `${list.data.total} invoice${list.data.total === 1 ? "" : "s"}${list.data.dueCents ? ` · ${formatMoney(list.data.dueCents)} due` : ""}` : "Loading…"}</span>}>
        <Link className="btn" href="/price-list">Price list</Link>
        <Link className="btn primary" href="/invoices/new">New invoice</Link>
      </PageHead>
      <div className="tabs" role="tablist" aria-label="Invoices" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={status === k} onClick={() => setStatus(k)}>
            {label}{k === "mail" && !!mailCount.data?.length && <span className="badge warn" style={{ marginLeft: 6 }}>{mailCount.data.length}</span>}
          </button>
        ))}
      </div>
      <form className="card filters" role="search" aria-label="Search invoices" onSubmit={(e) => e.preventDefault()}>
        <label>Search<input type="search" placeholder="Invoice #, customer, address, PO" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      </form>
      {status === "mail" && rows.length > 0 && (
        <div className="card row" style={{ justifyContent: "space-between" }}>
          <span>{picked.length} of {rows.length} selected. They print in ZIP order, after a cover sheet, folded for a #10 double-window envelope.</span>
          <span className="row">
            <a className={`btn primary ${picked.length ? "" : "disabled"}`} href={picked.length ? `${API_URL}/invoices/print?ids=${picked.join(",")}` : undefined} target="_blank" rel="noopener noreferrer">Print selected (PDF)</a>
            <button className="btn" disabled={!picked.length || mailing.busy} onClick={() => confirm(`Mark ${picked.length} invoice${picked.length === 1 ? "" : "s"} as mailed today?`) && mailing.run(async () => {
              await api("/invoices/mark-mailed", { body: { ids: picked } }); list.reload(); mailCount.reload();
            })}>Mark mailed</button>
          </span>
          <ErrorBox error={mailing.error} />
        </div>
      )}
      <ErrorBox error={list.error} />
      <div className="card tablewrap">
        {rows.length ? (
          <table>
            <thead><tr>{status === "mail" && <th><input type="checkbox" aria-label="Select all" checked={picked.length === rows.length} onChange={(e) => setPicked(e.target.checked ? rows.map((r) => r.id) : [])} /></th>}<th>#</th><th>Customer</th><th>Service address</th><th>Date</th><th>Due</th><th style={{ textAlign: "right" }}>Total</th><th style={{ textAlign: "right" }}>Balance</th><th>Status</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                {status === "mail" && <td><input type="checkbox" aria-label={`Select invoice ${r.number}`} checked={picked.includes(r.id)} onChange={() => toggle(r.id)} /></td>}
                <td><Link href={`/invoices/${r.id}`}><strong>{r.number ?? "Draft"}</strong></Link></td>
                <td><Link href={`/customers/${r.customerId}`}>{r.customerName}</Link>{r.poNumber && <div className="muted">PO {r.poNumber}</div>}</td>
                <td>{r.street ?? <span className="muted">—</span>}{status === "mail" && r.zip && <div className="muted">{r.zip}</div>}</td>
                <td>{fmtDate(r.issueDate)}</td>
                <td>{fmtDate(r.dueDate)}</td>
                <td style={{ textAlign: "right" }}>{formatMoney(r.totalCents)}</td>
                <td style={{ textAlign: "right" }}>{r.status === "void" ? "—" : formatMoney(r.balanceCents)}</td>
                <td><InvoiceStatus status={r.status} overdue={r.overdue} />{r.needsMailing && <span className="badge" style={{ marginLeft: 4 }} title="Waiting to be printed and mailed">to mail</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : list.loading ? <Empty>Loading…</Empty> : <Empty>{query ? "No invoices match." : status === "mail" ? "Nothing waiting to be mailed." : "No invoices here yet."}</Empty>}
      </div>
    </>
  );
}

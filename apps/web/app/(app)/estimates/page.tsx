"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { formatMoney } from "@crewdesk/shared";
import { fmtDate } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { Icon } from "@/components/icons";
import { EstimateStatus } from "@/components/estimates";

const TABS = [["all", "Total"], ["sent", "Pending"], ["accepted", "Accepted"], ["declined", "Declined"], ["changes", "Changes requested"], ["draft", "Drafts"]] as const;
type Row = { id: string; number: number; title: string | null; status: string; issueDate: string; validUntil: string | null; totalCents: number; viewedAt: string | null; respondedAt: string | null; expired: boolean; visitId: string | null; invoiceId: string | null; customer: { id: string; name: string } };

/** Estimates, like Homeworks': counts by status as small tabs, a search, and the list. */
function Estimates() {
  const router = useRouter();
  const params = useSearchParams();
  const status = params.get("status") ?? "all";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [q, setQ] = useState(params.get("q") ?? "");
  const set = (patch: Record<string, string | null>) => {
    const u = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) { if (!v) u.delete(k); else u.set(k, v); }
    if (!("page" in patch)) u.delete("page");
    router.replace(`/estimates${u.toString() ? `?${u}` : ""}`, { scroll: false });
  };
  useEffect(() => { const t = setTimeout(() => { if (q !== (params.get("q") ?? "")) set({ q: q.trim() || null }); }, 300); return () => clearTimeout(t); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const size = 50;
  const list = useApi<{ total: number; counts: Record<string, number>; rows: Row[] }>(`/estimates?status=${status}&limit=${size}&offset=${(page - 1) * size}${params.get("q") ? `&q=${encodeURIComponent(params.get("q")!)}` : ""}`);
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  return (
    <>
      <PageHead title="Estimates" sub="Quotes for customers to accept online, then make into work orders or invoices">
        <Link className="btn primary" href="/estimates/new"><Icon name="plus" size={14} /> New estimate</Link>
      </PageHead>
      <section className="card cl-bar" aria-label="Find estimates">
        <div className="cl-bar-row">
          <div className="cl-stats" role="tablist" aria-label="Status">
            {TABS.map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={status === k} className={status === k ? "on" : ""} onClick={() => set({ status: k === "all" ? null : k })}>
                {l} <b>{list.data ? (list.data.counts[k] ?? 0).toLocaleString() : "·"}</b>
              </button>
            ))}
          </div>
          <input className="cl-search" type="search" placeholder="Search: customer, title, #" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search estimates" />
        </div>
      </section>
      <ErrorBox error={list.error} />
      <div className="card tablewrap">
        {rows.length ? (
          <table>
            <thead><tr><th>#</th><th>Date</th><th>Customer</th><th>Title</th><th className="num">Total</th><th>Status</th><th>Next step</th></tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e.id}>
                <td><Link href={`/estimates/${e.id}`}><strong>{e.number}</strong></Link></td>
                <td className="nowrap">{fmtDate(e.issueDate)}</td>
                <td><Link href={`/customers/${e.customer.id}`}>{e.customer.name}</Link></td>
                <td>{e.title ?? <span className="muted">—</span>}</td>
                <td className="num">{formatMoney(e.totalCents)}</td>
                <td className="nowrap"><EstimateStatus status={e.status} expired={e.expired} />{e.status === "sent" && e.viewedAt && <span className="muted" style={{ fontSize: 12 }}> · seen</span>}</td>
                <td className="muted">
                  {e.status === "draft" ? "Send it" : e.status === "changes" ? "Change and resend" : e.status === "accepted"
                    ? (e.visitId || e.invoiceId ? [e.visitId && "Work order made", e.invoiceId && "Invoiced"].filter(Boolean).join(" · ") : "Make a work order or invoice")
                    : e.status === "sent" ? (e.expired ? "Expired: follow up" : "Waiting for the customer") : ""}
                </td>
              </tr>
            ))}</tbody>
          </table>
        ) : list.loading ? <Empty>Loading…</Empty> : <Empty>{params.get("q") || status !== "all" ? "No estimates match." : "No estimates yet. Make one with New estimate."}</Empty>}
        {total > size && (
          <div className="cl-pager">
            <span className="muted">{((page - 1) * size + 1).toLocaleString()}–{Math.min(total, page * size).toLocaleString()} of {total.toLocaleString()}</span>
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn" disabled={page <= 1} onClick={() => set({ page: page > 2 ? String(page - 1) : null })}>‹ Previous</button>
              <button type="button" className="btn" disabled={page * size >= total} onClick={() => set({ page: String(page + 1) })}>Next ›</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export default function Page() { return <Suspense><Estimates /></Suspense>; }

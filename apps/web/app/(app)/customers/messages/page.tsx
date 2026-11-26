"use client";
import Link from "next/link";
import { useState } from "react";
import { fmtDate } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { CrmTabs } from "@/components/customer-list";
import { MESSAGE_STATUS } from "@/components/customer-messages";

type Row = { id: string; subject: string; status: keyof typeof MESSAGE_STATUS; audience: string | null; byName: string | null; createdAt: string; counts: Record<string, number> | null };

/** Customers → Bulk emails: emails sent to many customers from the Customers list, newest first. */
export default function Messages() {
  const [page, setPage] = useState(0);
  const size = 50;
  const list = useApi<{ total: number; rows: Row[] }>(`/customer-messages?limit=${size}&offset=${page * size}`);
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  return (
    <>
      <PageHead title="Customers" sub={<CrmTabs at="messages" />} />
      <ErrorBox error={list.error} />
      <div className="card tablewrap">
        {rows.length ? (
          <table>
            <thead><tr><th>Sent</th><th>Subject</th><th>To</th><th className="num">Sent</th><th className="num">Didn&apos;t go</th><th className="num">Skipped</th><th>Status</th><th>By</th></tr></thead>
            <tbody>{rows.map((m) => (
              <tr key={m.id}>
                <td className="nowrap">{fmtDate(m.createdAt)}</td>
                <td><Link href={`/customers/messages/${m.id}`}><strong>{m.subject}</strong></Link></td>
                <td className="muted">{m.audience ?? "—"}</td>
                <td className="num">{(m.counts?.sent ?? 0).toLocaleString()}{m.status === "sending" ? ` of ${((m.counts?.sent ?? 0) + (m.counts?.queued ?? 0) + (m.counts?.sending ?? 0)).toLocaleString()}` : ""}</td>
                <td className="num">{m.counts?.failed ? <span className="bad-text">{m.counts.failed.toLocaleString()}</span> : "—"}</td>
                <td className="num">{m.counts?.skipped ? m.counts.skipped.toLocaleString() : "—"}</td>
                <td><span className={`badge${m.status === "sending" ? " info" : ""}`}>{MESSAGE_STATUS[m.status] ?? m.status}</span></td>
                <td className="muted">{m.byName ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : list.loading ? <Empty>Loading…</Empty> : (
          <Empty>Nothing sent yet. On the Customers list, filter or tick the customers you want, then choose Send → Email.</Empty>
        )}
        {total > size && (
          <div className="cl-pager">
            <span className="muted">{(page * size + 1).toLocaleString()}–{Math.min(total, (page + 1) * size).toLocaleString()} of {total.toLocaleString()}</span>
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn" disabled={!page} onClick={() => setPage(page - 1)}>‹ Previous</button>
              <button type="button" className="btn" disabled={(page + 1) * size >= total} onClick={() => setPage(page + 1)}>Next ›</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

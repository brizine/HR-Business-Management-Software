"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { MESSAGE_STATUS, RECIPIENT_STATUS_LABELS } from "@/components/customer-messages";

type Recipient = { id: string; customerId: string | null; name: string; email: string | null; status: string; skipLabel: string | null; error: string | null; sentAt: string | null };
type Message = {
  id: string; subject: string; body: string; status: keyof typeof MESSAGE_STATUS; audience: string | null; byName: string | null; createdAt: string; finishedAt: string | null;
  /** "template": a document (Resources → Documents), formatted, with {{TAGS}}. */
  format?: string; docName?: string | null; attachPdf?: boolean;
  counts: Record<string, number> | null; recipients: Recipient[];
};

/** One email sent to many customers: what it said, and how it went for each customer. */
export default function MessageDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const msg = useApi<Message>(`/customer-messages/${id}`);
  const stop = useAction();
  const [show, setShow] = useState<string>("all");
  const m = msg.data;
  // While it's sending, keep the counts moving.
  useEffect(() => {
    if (m?.status !== "sending") return;
    const t = setInterval(() => msg.reload(), 3000);
    return () => clearInterval(t);
  }, [m?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (msg.error) return <><PageHead title="Bulk email" /><ErrorBox error={msg.error} /></>;
  if (!m) return <PageHead title="Bulk email" sub="Loading…" />;
  const c = m.counts ?? {};
  const left = (c.queued ?? 0) + (c.sending ?? 0);
  const rows = show === "all" ? m.recipients : m.recipients.filter((r) => r.status === show);
  return (
    <>
      <PageHead title={m.subject} before={<Link className="btn" href="/customers/messages" aria-label="Back to bulk emails">←</Link>}
        sub={<>{MESSAGE_STATUS[m.status] ?? m.status} · {fmtDate(m.createdAt)}{m.byName ? ` by ${m.byName}` : ""}{m.audience ? ` · ${m.audience}` : ""}</>}>
        {m.status === "sending" && (
          <button className="btn danger" disabled={stop.busy} onClick={() => confirm(`Stop sending? The ${left.toLocaleString()} not sent yet won't get it.`) && stop.run(async () => { await api(`/customer-messages/${id}/stop`, { method: "POST" }); msg.reload(); })}>Stop sending</button>
        )}
      </PageHead>
      <ErrorBox error={stop.error} />
      <div className="grid cols-2">
        <div className="card">
          <h2 style={{ fontSize: 16, marginTop: 0 }}>How it went</h2>
          <dl className="facts">
            <dt>Sent</dt><dd><strong>{(c.sent ?? 0).toLocaleString()}</strong>{m.status === "sending" ? ` · ${left.toLocaleString()} to go` : ""}</dd>
            <dt>Didn&apos;t go</dt><dd>{c.failed ? <span className="bad-text">{c.failed.toLocaleString()}</span> : "None"}</dd>
            <dt>Skipped</dt><dd>{(c.skipped ?? 0).toLocaleString()}</dd>
            <dt>On the list</dt><dd>{(c.total ?? 0).toLocaleString()}</dd>
            {m.finishedAt && <><dt>Finished</dt><dd>{new Date(m.finishedAt).toLocaleString()}</dd></>}
          </dl>
        </div>
        <div className="card">
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Message</h2>
          {m.format === "template" ? (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                {m.docName ? <>The document <strong>{m.docName}</strong>{m.attachPdf ? " (sent with the letter attached as a PDF)" : ""}. </> : null}
                Fill-ins like {"{{CUSTOMER_NAME}}"} were filled in for each customer.
              </p>
              <iframe title="What was sent" sandbox="" srcDoc={`<body style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#1d2939;margin:8px">${m.body}</body>`} className="cm-frame" style={{ marginTop: 0, borderRadius: 8 }} />
            </>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0 }}>Fill-in fields like {"{first_name}"} were filled in for each customer.</p>
              <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
            </>
          )}
        </div>
      </div>
      <div className="card tablewrap">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>Customers</h2>
          <label className="row" style={{ gap: 6 }}>Show
            <select value={show} onChange={(e) => setShow(e.target.value)} aria-label="Show customers">
              <option value="all">Everyone ({(c.total ?? 0).toLocaleString()})</option>
              <option value="sent">Sent ({(c.sent ?? 0).toLocaleString()})</option>
              <option value="failed">Didn&apos;t go ({(c.failed ?? 0).toLocaleString()})</option>
              <option value="skipped">Skipped ({(c.skipped ?? 0).toLocaleString()})</option>
              {left > 0 && <option value="queued">Waiting ({(c.queued ?? 0).toLocaleString()})</option>}
            </select>
          </label>
        </div>
        {rows.length ? (
          <table>
            <thead><tr><th>Customer</th><th>Email</th><th>Status</th><th>Details</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td>{r.customerId ? <Link href={`/customers/${r.customerId}`}>{r.name}</Link> : r.name}</td>
                <td className="muted">{r.email ?? "—"}</td>
                <td className="nowrap">{r.status === "failed" ? <span className="bad-text">{RECIPIENT_STATUS_LABELS[r.status]}</span> : RECIPIENT_STATUS_LABELS[r.status] ?? r.status}</td>
                <td className="muted">{r.error ?? r.skipLabel ?? (r.sentAt ? new Date(r.sentAt).toLocaleString() : "")}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>Nobody here.</Empty>}
      </div>
    </>
  );
}

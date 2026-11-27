"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { MESSAGE_FIELDS, NOTICE_CHANNEL_LABELS, NOTICE_FIELDS, NOTICE_STATUS_LABELS, type ChemicalNoticeSettings, type NoticeChannel } from "@crewdesk/shared";
import { api, fmtDate, fmtDateTime } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";

interface Notice {
  id: string; recordId: string; channel: string; status: string; to: string | null; recipient: string | null; subject: string | null; body: string; detail: string | null;
  sentAt: string | null; printedAt: string | null; createdAt: string; customerId: string | null; customerName: string; siteAddress: string | null; appliedOn: string;
}
type Settings = ChemicalNoticeSettings & { emailReady: boolean; textingReady: boolean };
const TONE: Record<string, string> = { sent: "ok", printed: "ok", to_print: "warn", failed: "bad", skipped: "", sending: "info" };

/**
 * After-application notices: what each customer was told (or will get on paper), and the wording.
 * Each property picks email, text, printed or none (on the property's page); off until turned on here.
 */
export default function Notices() {
  const [show, setShow] = useState<"all" | "to_print" | "problems">("all");
  // A link can open it filtered (e.g. from My Day: ?show=…).
  useEffect(() => { const v = new URLSearchParams(window.location.search).get("show"); if (v) setShow(v as never); }, []);
  const list = useApi<Notice[]>(`/chemical-tracking/notices${show === "all" ? "" : `?status=${show}`}`);
  const [picked, setPicked] = useState<string[]>([]);
  const act = useAction();
  const rows = list.data ?? [];
  const printable = rows.filter((n) => n.channel === "printed");
  const markPrinted = (ids: string[], printed = true) => act.run(async () => { await api("/chemical-tracking/notices/printed", { method: "POST", body: { ids, printed } }); setPicked([]); list.reload(); });
  const toPrint = rows.filter((n) => n.status === "to_print");
  return (
    <>
      <PageHead title="Customer notices" sub="After a chemical work order is completed, the customer gets what was applied and how long to stay off the lawn: by email, text or a printed notice, as each property is set.">
        {toPrint.length > 0 && <Link className="btn primary" href={`/chemical-tracking/notices/print?ids=${toPrint.map((n) => n.id).join(",")}`}>Print {toPrint.length} waiting</Link>}
      </PageHead>
      <NoticeSettings />
      <div className="row" style={{ margin: "16px 0 12px", alignItems: "flex-end" }}>
        <label style={{ width: 220 }}>Show
          <select value={show} onChange={(e) => { setShow(e.target.value as typeof show); setPicked([]); }}>
            <option value="all">All notices</option><option value="to_print">Waiting to print</option><option value="problems">Didn&apos;t send or skipped</option>
          </select>
        </label>
        {picked.length > 0 && <>
          <Link className="btn" href={`/chemical-tracking/notices/print?ids=${picked.join(",")}`}>Print {picked.length}</Link>
          <button className="btn" disabled={act.busy} onClick={() => markPrinted(picked)}>Mark printed</button>
        </>}
      </div>
      <ErrorBox error={list.error ?? act.error} />
      <div className="card tablewrap">
        {rows.length ? (
          <table>
            <thead><tr>
              <th style={{ width: 28 }}>{printable.length > 0 && <input type="checkbox" aria-label="Pick all printed notices" checked={picked.length === printable.length} onChange={(e) => setPicked(e.target.checked ? printable.map((n) => n.id) : [])} />}</th>
              <th>Applied</th><th>Customer</th><th>How</th><th>Status</th><th />
            </tr></thead>
            <tbody>{rows.map((n) => (
              <tr key={n.id}>
                <td>{n.channel === "printed" && <input type="checkbox" aria-label={`Pick ${n.customerName}`} checked={picked.includes(n.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, n.id] : picked.filter((x) => x !== n.id))} />}</td>
                <td><Link href={`/chemical-tracking/records/${n.recordId}`}>{fmtDate(n.appliedOn)}</Link></td>
                <td>{n.customerId ? <Link href={`/customers/${n.customerId}`}>{n.customerName}</Link> : n.customerName}{n.recipient && <div title="A contact on the property who is ticked to get its service notifications">To {n.recipient}</div>}<div className="muted">{n.siteAddress}</div></td>
                <td>{n.channel === "call" ? "Phone call" : NOTICE_CHANNEL_LABELS[n.channel as NoticeChannel] ?? n.channel}{n.to ? <div className="muted">{n.to}</div> : null}</td>
                <td>
                  <span className={`badge ${TONE[n.status] ?? ""}`}>{NOTICE_STATUS_LABELS[n.status] ?? n.status}</span>
                  <div className="muted">{n.detail ?? (n.sentAt ? fmtDateTime(n.sentAt) : n.printedAt ? fmtDateTime(n.printedAt) : "")}</div>
                </td>
                <td className="row">
                  <Link className="btn" href={`/chemical-tracking/notices/print?ids=${n.id}`}>View</Link>
                  {n.status === "printed" && <button className="btn" disabled={act.busy} onClick={() => markPrinted([n.id], false)}>Print again</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        ) : list.loading ? <Empty>Loading…</Empty> : <Empty>{show === "all" ? "No notices yet. They're made when a chemical work order is completed, once notices are on." : "Nothing here."}</Empty>}
      </div>
    </>
  );
}

function NoticeSettings() {
  const s = useApi<Settings>("/chemical-tracking/notice-settings");
  const [f, setF] = useState<ChemicalNoticeSettings | null>(null);
  const [open, setOpen] = useState(false);
  const act = useAction();
  useEffect(() => { if (s.data && !f) setF({ on: s.data.on, emailSubject: s.data.emailSubject, emailBody: s.data.emailBody, textBody: s.data.textBody }); }, [s.data, f]);
  if (!s.data || !f) return <ErrorBox error={s.error} />;
  const save = (next: ChemicalNoticeSettings) => act.run(async () => { await api("/chemical-tracking/notice-settings", { method: "PUT", body: next }); setF(next); s.reload(); });
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <label className="check" style={{ fontWeight: 600 }}>
          <input type="checkbox" checked={f.on} disabled={act.busy} onChange={(e) => save({ ...f, on: e.target.checked })} /> Send a notice after each chemical application
        </label>
        <button type="button" className="linkbtn" onClick={() => setOpen(!open)}>{open ? "Hide the wording" : "Change the wording"}</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Each property chooses email (the default), text, printed or no notice, on the property&apos;s page.
        {!s.data.emailReady && <> <span className="warn-text">Email isn&apos;t set up on the server, so email notices are skipped.</span></>}
        {!s.data.textingReady && <> <span className="warn-text">Texting isn&apos;t connected (Settings → Integrations), so text notices are skipped.</span></>}
      </p>
      {open && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); save(f); }}>
          <label>Email subject<input value={f.emailSubject} onChange={(e) => setF({ ...f, emailSubject: e.target.value })} /></label>
          <label>Email (also the printed notice)<textarea rows={10} value={f.emailBody} onChange={(e) => setF({ ...f, emailBody: e.target.value })} /></label>
          <label>Text <span className="muted">({f.textBody.length} characters; texts over 160 go as several)</span><textarea rows={3} value={f.textBody} onChange={(e) => setF({ ...f, textBody: e.target.value })} /></label>
          <details>
            <summary>Fill-ins you can use</summary>
            <ul className="plain-list">
              {NOTICE_FIELDS.map(([k, d]) => <li key={k}><code>{`{${k}}`}</code> <span className="muted">{d}</span></li>)}
              {MESSAGE_FIELDS.filter(([k]) => ["first_name", "name", "company", "company_phone"].includes(k)).map(([k, d]) => <li key={k}><code>{`{${k}}`}</code> <span className="muted">{d}</span></li>)}
            </ul>
          </details>
          <ErrorBox error={act.error} />
          <div className="row"><button className="btn primary" disabled={act.busy}>Save wording</button></div>
        </form>
      )}
      {!open && <ErrorBox error={act.error} />}
    </div>
  );
}

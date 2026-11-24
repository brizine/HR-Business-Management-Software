"use client";
import Link from "next/link";
import { useState } from "react";
import { ODAFF_RULE, formatRateAmount, windText } from "@crewdesk/shared";
import { download, fmtDate } from "@/lib/api";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";

interface Row {
  id: string; visitId: string | null; visitNumber: number | null; appliedOn: string; startedAt: string | null; stoppedAt: string | null;
  customerName: string; siteAddress: string | null; applicatorName: string; issues: string[]; voidedAt: string | null;
  products: { id: string; tradeName: string; epaRegNo: string | null; amount: number; unit: string }[];
  weather: { source: string | null; windMph: number | null; windDeg: number | null; gustMph: number | null; tempF: number | null } | null;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const time = (d: string | null) => (d ? new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—");

/** The chemical application log (ODAFF): every record, filters, the export for an inspection, and what records draw on. */
export default function ChemicalRecords() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(daysAgo(0));
  const [status, setStatus] = useState("all");
  const qs = new URLSearchParams({ from, to, status }).toString();
  const list = useApi<Row[]>(`/chemical-records?${qs}`);
  const act = useAction();
  const rows = list.data ?? [];
  const withIssues = rows.filter((r) => r.issues.length && !r.voidedAt).length;
  return (
    <>
      <PageHead title="Application records"
        sub={`Application records for the Oklahoma Department of Agriculture (${ODAFF_RULE}). Made when a work order that applies tracked products is completed; never deleted.`}>
        <button className="btn" disabled={act.busy} onClick={() => act.run(() => download(`/chemical-records/export.csv?${qs}`))}>Export CSV</button>
      </PageHead>
      <div className="row" style={{ marginBottom: 12, alignItems: "flex-end" }}>
        <label style={{ width: 170 }}>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label style={{ width: 170 }}>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label style={{ width: 200 }}>Show
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All records</option><option value="issues">Records with something missing</option><option value="voided">Voided (reopened work orders)</option>
          </select>
        </label>
        {withIssues > 0 && status !== "issues" && <span className="badge warn">{withIssues} need attention</span>}
      </div>
      <ErrorBox error={list.error ?? act.error} />
      <div className="card tablewrap">
        {rows.length ? (
          <table>
            <thead><tr><th>Date</th><th>Customer / site</th><th>Applicator</th><th>Products</th><th>Weather</th><th>Status</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} style={{ opacity: r.voidedAt ? 0.6 : 1 }}>
                <td><Link href={`/chemical-tracking/records/${r.id}`}><strong>{fmtDate(r.appliedOn)}</strong></Link><div className="muted">{time(r.startedAt)}–{time(r.stoppedAt)}{r.visitNumber ? ` · WO-${r.visitNumber}` : ""}</div></td>
                <td>{r.customerName}<div className="muted">{r.siteAddress}</div></td>
                <td>{r.applicatorName}</td>
                <td>{r.products.map((p) => <div key={p.id}>{p.tradeName} <span className="muted">{formatRateAmount(p.amount, p.unit)}</span></div>)}</td>
                <td>{r.weather?.source ? <>{windText(r.weather)}{r.weather.tempF != null && <div className="muted">{r.weather.tempF}°F</div>}</> : <span className="muted">pending</span>}</td>
                <td>{r.voidedAt ? <span className="badge">voided</span> : r.issues.length ? <span className="badge warn" title={r.issues.join("\n")}>{r.issues.length} missing</span> : <span className="badge ok">complete</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : list.loading ? <Empty>Loading…</Empty> : <Empty>No records in these dates. Records are made when a work order with a chemical service or tracked products is completed.</Empty>}
      </div>
    </>
  );
}

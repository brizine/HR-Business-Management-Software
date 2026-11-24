"use client";
import Link from "next/link";
import { useState } from "react";
import { ODAFF_RULE, formatRateAmount, windText } from "@crewdesk/shared";
import { api, download, fmtDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction, useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";

interface Row {
  id: string; visitId: string | null; visitNumber: number | null; appliedOn: string; startedAt: string | null; stoppedAt: string | null;
  customerName: string; siteAddress: string | null; applicatorName: string; issues: string[]; voidedAt: string | null;
  products: { id: string; tradeName: string; epaRegNo: string | null; amount: number; unit: string }[];
  weather: { source: string | null; windMph: number | null; windDeg: number | null; gustMph: number | null; tempF: number | null } | null;
}
interface Applicator { id: string; name: string; certNo: string | null; expiresOn: string | null; categories: string | null }

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const time = (d: string | null) => (d ? new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—");

/** The chemical application log (ODAFF): every record, filters, the export for an inspection, and what records draw on. */
export default function ChemicalRecords() {
  const { can } = useAuth();
  const admin = can("admin", "customers");
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
      <PageHead title="Chemical records"
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
                <td><Link href={`/chemical-records/${r.id}`}><strong>{fmtDate(r.appliedOn)}</strong></Link><div className="muted">{time(r.startedAt)}–{time(r.stoppedAt)}{r.visitNumber ? ` · WO-${r.visitNumber}` : ""}</div></td>
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
      <RecordSettings admin={admin} />
    </>
  );
}

/** What every record draws on: the company license number and each applicator's certification. */
function RecordSettings({ admin }: { admin: boolean }) {
  const settings = useApi<{ pesticideLicenseNo: string | null }>("/chemical-records/settings");
  const people = useApi<Applicator[]>("/chemical-records/applicators");
  const [license, setLicense] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [cert, setCert] = useState({ certNo: "", expiresOn: "", categories: "" });
  const act = useAction();
  const today = daysAgo(0);
  const soon = daysAgo(-60);
  const saveLicense = () => act.run(async () => { await api("/chemical-records/settings", { method: "PUT", body: { pesticideLicenseNo: license ?? "" } }); setLicense(null); settings.reload(); });
  const saveCert = (id: string) => act.run(async () => { await api(`/chemical-records/applicators/${id}`, { method: "PUT", body: cert }); setEditing(null); people.reload(); });
  const removeCert = (id: string) => act.run(async () => { await api(`/chemical-records/applicators/${id}`, { method: "DELETE" }); people.reload(); });
  return (
    <div className="card stack" style={{ marginTop: 16 }}>
      <h3 style={{ margin: 0 }}>Record details</h3>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label style={{ width: 260 }}>Company pesticide license #
          <input value={license ?? settings.data?.pesticideLicenseNo ?? ""} disabled={!admin} onChange={(e) => setLicense(e.target.value)} />
        </label>
        {admin && license !== null && <button className="btn primary" disabled={act.busy} onClick={saveLicense}>Save</button>}
      </div>
      <h4 style={{ margin: "8px 0 0" }}>Certified applicators <span className="muted">(name, certification # and expiration go on every record they make)</span></h4>
      <ErrorBox error={act.error} />
      <div className="tablewrap">
        <table>
          <thead><tr><th>Employee</th><th>Certification #</th><th>Expires</th><th>Categories</th>{admin && <th />}</tr></thead>
          <tbody>{(people.data ?? []).map((p) => editing === p.id ? (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td><input aria-label="Certification number" value={cert.certNo} onChange={(e) => setCert({ ...cert, certNo: e.target.value })} /></td>
              <td><input aria-label="Expires" type="date" value={cert.expiresOn} onChange={(e) => setCert({ ...cert, expiresOn: e.target.value })} /></td>
              <td><input aria-label="Categories" value={cert.categories} onChange={(e) => setCert({ ...cert, categories: e.target.value })} placeholder="e.g. 3A, 7A" /></td>
              <td className="row"><button className="btn primary" disabled={act.busy} onClick={() => saveCert(p.id)}>Save</button><button className="btn" onClick={() => setEditing(null)}>Cancel</button></td>
            </tr>
          ) : (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.certNo ?? <span className="muted">none</span>}</td>
              <td>{p.expiresOn ? <>{fmtDate(p.expiresOn)} {p.expiresOn < today ? <span className="badge bad">expired</span> : p.expiresOn <= soon ? <span className="badge warn">expires soon</span> : null}</> : ""}</td>
              <td>{p.categories ?? ""}</td>
              {admin && <td className="row">
                <button className="btn" onClick={() => { setEditing(p.id); setCert({ certNo: p.certNo ?? "", expiresOn: p.expiresOn ?? "", categories: p.categories ?? "" }); }}>{p.certNo ? "Edit" : "Add"}</button>
                {p.certNo && <button className="btn" disabled={act.busy} onClick={() => confirm(`Remove ${p.name}'s certification?`) && removeCert(p.id)}>Remove</button>}
              </td>}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

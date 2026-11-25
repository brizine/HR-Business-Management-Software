"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
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

/** A local date n days back (not UTC, so evenings stay on today). */
const daysAgo = (n: number) => { const d = new Date(Date.now() - n * 86_400_000); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); };
const time = (d: string | null) => (d ? new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—");

/** The chemical application log (ODAFF): every record, filters, the export for an inspection, and what records draw on. */
export default function ChemicalRecords() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(daysAgo(0));
  const [status, setStatus] = useState("all");
  // A link can open it filtered (e.g. from My Day: ?status=…).
  useEffect(() => { const v = new URLSearchParams(window.location.search).get("status"); if (v) setStatus(v as never); }, []);
  const [view, setView] = useState<"records" | "monthly">("records");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [mapCode, setMapCode] = useState("");
  const [productId, setProductId] = useState("");
  const [applicatorId, setApplicatorId] = useState("");
  // Typing in the property search waits a moment before searching.
  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 350); return () => clearTimeout(t); }, [search]);
  const products = useApi<{ id: string; name: string }[]>("/products?all=1");
  const applicators = useApi<{ id: string; name: string; certNo: string | null }[]>("/chemical-records/applicators");
  const mapCodes = useApi<string[]>("/chemical-records/map-codes");
  const qs = new URLSearchParams(Object.entries({ from, to, status, q, mapCode: mapCode.trim(), productId, applicatorId }).filter(([, v]) => v)).toString();
  const list = useApi<Row[]>(view === "records" ? `/chemical-records?${qs}` : null);
  const monthly = useApi<Monthly[]>(view === "monthly" ? `/chemical-records/monthly?${qs}` : null);
  const act = useAction();
  const base = view === "records" ? "/chemical-records/export" : "/chemical-records/monthly";
  const filtered = !!(q || mapCode.trim() || productId || applicatorId);
  const rows = list.data ?? [];
  const withIssues = rows.filter((r) => r.issues.length && !r.voidedAt).length;
  return (
    <>
      <PageHead title="Application records"
        sub={`Application records for the Oklahoma Department of Agriculture (${ODAFF_RULE}). Made when a work order that applies tracked products is completed; never deleted.`}>
        <button className="btn" disabled={act.busy} onClick={() => act.run(() => download(`${base}.pdf?${qs}`))}>Export PDF</button>
        <button className="btn" disabled={act.busy} onClick={() => act.run(() => download(`${base}.csv?${qs}`))}>Export CSV</button>
      </PageHead>
      <div className="row" role="group" aria-label="View" style={{ gap: 6, marginBottom: 12 }}>
        <button className={`btn ${view === "records" ? "primary" : ""}`} onClick={() => setView("records")}>Records</button>
        <button className={`btn ${view === "monthly" ? "primary" : ""}`} onClick={() => setView("monthly")}>Monthly product totals</button>
      </div>
      <div className="row" style={{ marginBottom: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ width: 160 }}>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label style={{ width: 160 }}>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label style={{ width: 220 }}>Property<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Customer or address" /></label>
        <label style={{ width: 120 }}>Map Code<input value={mapCode} list="record-map-codes" onChange={(e) => setMapCode(e.target.value)} placeholder="Any" /></label>
        <datalist id="record-map-codes">{(mapCodes.data ?? []).map((c) => <option key={c} value={c} />)}</datalist>
        <label style={{ width: 200 }}>Product
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Any product</option>
            {(products.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label style={{ width: 180 }}>Applicator
          <select value={applicatorId} onChange={(e) => setApplicatorId(e.target.value)}>
            <option value="">Anyone</option>
            {(applicators.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label style={{ width: 200 }}>Show
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All records</option><option value="issues">Records with something missing</option><option value="voided">Voided (reopened work orders)</option>
          </select>
        </label>
        {filtered && <button type="button" className="linkbtn" style={{ alignSelf: "center" }} onClick={() => { setSearch(""); setQ(""); setMapCode(""); setProductId(""); setApplicatorId(""); }}>Clear filters</button>}
        {view === "records" && withIssues > 0 && status !== "issues" && <span className="badge warn" style={{ alignSelf: "center" }}>{withIssues} need attention</span>}
      </div>
      <ErrorBox error={list.error ?? monthly.error ?? act.error} />
      {view === "monthly" ? <MonthlyTotals rows={monthly.data ?? undefined} loading={monthly.loading} /> : (
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
        ) : list.loading ? <Empty>Loading…</Empty> : <Empty>{filtered ? "No records match these filters." : "No records in these dates. Records are made when a work order with a chemical service or tracked products is completed."}</Empty>}
      </div>
      )}
    </>
  );
}

interface Monthly { month: string; productId: string | null; tradeName: string; epaRegNo: string | null; unit: string; amount: number; applications: number }
const monthName = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** How much of each product went down each month (for the filters above). */
function MonthlyTotals({ rows, loading }: { rows: Monthly[] | undefined; loading: boolean }) {
  const list = rows ?? [];
  return (
    <div className="card tablewrap">
      {list.length ? (
        <table>
          <thead><tr><th>Month</th><th>Product</th><th>EPA reg #</th><th>Total applied</th><th>Applications</th></tr></thead>
          <tbody>{list.map((r, i) => {
            const first = i === 0 || list[i - 1].month !== r.month;
            return (
              <tr key={`${r.month}-${r.productId ?? r.tradeName}-${r.unit}`} style={first && i ? { borderTop: "2px solid var(--border, #e4e7ec)" } : undefined}>
                <td>{first ? <strong>{monthName(r.month)}</strong> : ""}</td>
                <td>{r.tradeName}</td>
                <td>{r.epaRegNo ?? ""}</td>
                <td>{formatRateAmount(Math.round(r.amount * 100) / 100, r.unit)}</td>
                <td>{r.applications}</td>
              </tr>
            );
          })}</tbody>
        </table>
      ) : loading ? <Empty>Loading…</Empty> : <Empty>No records match these filters.</Empty>}
    </div>
  );
}

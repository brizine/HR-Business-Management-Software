"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { money } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { economyText } from "@/components/fuel-log";

type Row = {
  assetId: string; name: string; type: string; meter: "odometer" | "hours"; fills: number; quantity: number; defQuantity: number; fuelCents: number;
  avgPriceCents: number | null; economy: number | null; usualEconomy: number | null; economyDrop: number | null; maintenanceCents: number; totalCents: number;
  miles: number; hours: number; perMileCents: number | null; perHourCents: number | null;
  tco: { totalCents: number; perMileCents: number | null; perHourCents: number | null; miles: number; hours: number };
};
type Report = { from: string; to: string; rows: Row[]; totals: { fuelCents: number; maintenanceCents: number; totalCents: number; quantity: number; miles: number } };

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function preset(p: string): [string, string] {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  switch (p) {
    case "last_month": return [ymd(new Date(y, m - 1, 1)), ymd(new Date(y, m, 0))];
    case "ytd": return [ymd(new Date(y, 0, 1)), ymd(now)];
    case "last_year": return [ymd(new Date(y - 1, 0, 1)), ymd(new Date(y - 1, 11, 31))];
    case "12m": return [ymd(new Date(y, m - 11, 1)), ymd(now)];
    default: return [ymd(new Date(y, m, 1)), ymd(now)];
  }
}
const cents = (c: number | null | undefined, d = 2) => (c == null ? "—" : `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const num = (n: number, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d });

/** Fleet-wide fuel, maintenance and cost per mile for a period, plus each asset's total cost of ownership. */
export default function FleetCosts() {
  const [range, setRange] = useState(preset("this_month"));
  const [which, setWhich] = useState("this_month");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"totalCents" | "fuelCents" | "perMileCents" | "name">("totalCents");
  const report = useApi<Report>(`/fuel/report?from=${range[0]}&to=${range[1]}`);
  const rows = useMemo(() => {
    const list = (report.data?.rows ?? []).filter((r) => !q || `${r.name} ${r.type}`.toLowerCase().includes(q.toLowerCase()));
    return [...list].sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : (b[sort] ?? -1) - (a[sort] ?? -1)));
  }, [report.data, q, sort]);
  const flagged = rows.filter((r) => r.economyDrop);
  const t = report.data?.totals;

  const exportCsv = () => {
    const cell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ["Asset", "Type", "Fill-ups", "Fuel (gal/GGE)", "DEF (gal)", "Fuel cost", "Avg price", "Economy", "Usual economy", "Maintenance", "Total", "Miles", "Engine hours", "Cost per mile", "Cost per hour", "Lifetime total cost of ownership", "TCO per mile", "TCO per hour"];
    const d = (c: number | null) => (c == null ? "" : (c / 100).toFixed(2));
    const body = rows.map((r) => [r.name, r.type, r.fills, r.quantity.toFixed(2), r.defQuantity.toFixed(2), d(r.fuelCents), r.avgPriceCents == null ? "" : (r.avgPriceCents / 100).toFixed(3),
      economyText(r.economy, r.meter), economyText(r.usualEconomy, r.meter), d(r.maintenanceCents), d(r.totalCents), num(r.miles), num(r.hours, 1),
      r.perMileCents == null ? "" : (r.perMileCents / 100).toFixed(3), d(r.perHourCents), d(r.tco.totalCents), r.tco.perMileCents == null ? "" : (r.tco.perMileCents / 100).toFixed(3), d(r.tco.perHourCents)]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([[head, ...body].map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv" }));
    a.download = `fleet-costs-${range[0]}-to-${range[1]}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <PageHead title="Fuel & Costs" sub="Fuel, maintenance and cost per mile for every asset, plus lifetime total cost of ownership.">
        <button className="btn primary" disabled={!rows.length} onClick={exportCsv}>Export CSV</button>
        <Link href="/fleet" className="btn primary">← Back to Assets</Link>
      </PageHead>
      <form className="card filters" role="search" aria-label="Filter fleet costs" onSubmit={(e) => e.preventDefault()}>
        <label>Period
          <select value={which} onChange={(e) => { setWhich(e.target.value); if (e.target.value !== "custom") setRange(preset(e.target.value)); }}>
            <option value="this_month">This month</option>
            <option value="last_month">Last month</option>
            <option value="ytd">This year so far</option>
            <option value="12m">Last 12 months</option>
            <option value="last_year">Last year</option>
            <option value="custom">Custom dates</option>
          </select>
        </label>
        <label>From<input type="date" value={range[0]} onChange={(e) => { setWhich("custom"); setRange([e.target.value, range[1]]); }} /></label>
        <label>To<input type="date" value={range[1]} onChange={(e) => { setWhich("custom"); setRange([range[0], e.target.value]); }} /></label>
        <label>Search<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Asset name or type…" /></label>
        <label>Sort by
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="totalCents">Total cost</option>
            <option value="fuelCents">Fuel cost</option>
            <option value="perMileCents">Cost per mile</option>
            <option value="name">Name</option>
          </select>
        </label>
      </form>
      <ErrorBox error={report.error} />
      {t && (
        <div className="stats">
          <div className="stat"><div className="v">{money(t.fuelCents)}</div><div className="l">Fuel</div></div>
          <div className="stat"><div className="v">{money(t.maintenanceCents)}</div><div className="l">Maintenance</div></div>
          <div className="stat"><div className="v">{money(t.totalCents)}</div><div className="l">Total</div></div>
          <div className="stat"><div className="v">{num(t.miles)}</div><div className="l">Miles driven</div></div>
          <div className="stat"><div className="v">{t.miles ? cents(rows.filter((r) => r.miles > 0).reduce((s, r) => s + r.totalCents, 0) / t.miles, 3) : "—"}</div><div className="l">Cost per mile (vehicles)</div></div>
        </div>
      )}
      {flagged.length > 0 && (
        <div className="card" role="status">
          <strong>⚠ Fuel economy down:</strong>{" "}
          {flagged.map((r, i) => <span key={r.assetId}>{i ? "; " : ""}<Link href={`/fleet/${r.assetId}`}>{r.name}</Link> {economyText(r.economy, r.meter)} vs usual {economyText(r.usualEconomy, r.meter)} ({Math.round(r.economyDrop! * 100)}% worse)</span>)}.
          <span className="muted"> Could be a maintenance issue (tires, filters, injectors), heavier work, or fuel going somewhere else.</span>
        </div>
      )}
      <div className="card tablewrap">
        {rows.length ? (
          <table>
            <thead><tr>
              <th>Asset</th><th style={{ textAlign: "right" }}>Fuel</th><th style={{ textAlign: "right" }}>Fuel cost</th><th>Economy</th>
              <th style={{ textAlign: "right" }}>Maintenance</th><th style={{ textAlign: "right" }}>Total</th><th style={{ textAlign: "right" }}>Ran</th><th style={{ textAlign: "right" }}>Cost / mi or hr</th>
              <th style={{ textAlign: "right" }}>Lifetime cost of ownership</th>
            </tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.assetId}>
                <td><Link href={`/fleet/${r.assetId}`}><strong>{r.name}</strong></Link><div className="muted" style={{ fontSize: 12 }}>{r.type}</div></td>
                <td style={{ textAlign: "right" }}>{r.fills ? `${num(r.quantity, 1)} gal` : "—"}{r.fills ? <div className="muted" style={{ fontSize: 12 }}>{r.fills} fill-up{r.fills === 1 ? "" : "s"}{r.avgPriceCents ? ` · ${cents(r.avgPriceCents, 3)}` : ""}</div> : null}</td>
                <td style={{ textAlign: "right" }}>{money(r.fuelCents)}</td>
                <td>{economyText(r.economy, r.meter)}{r.economyDrop ? <span className="badge bad" style={{ marginLeft: 6 }}>−{Math.round(r.economyDrop * 100)}%</span> : null}{r.usualEconomy && r.economy !== r.usualEconomy ? <div className="muted" style={{ fontSize: 12 }}>usual {economyText(r.usualEconomy, r.meter)}</div> : null}</td>
                <td style={{ textAlign: "right" }}>{money(r.maintenanceCents)}</td>
                <td style={{ textAlign: "right" }}><strong>{money(r.totalCents)}</strong></td>
                <td style={{ textAlign: "right" }}>{r.meter === "odometer" ? (r.miles ? `${num(r.miles)} mi` : "—") : (r.hours ? `${num(r.hours, 1)} hrs` : "—")}</td>
                <td style={{ textAlign: "right" }}>{r.meter === "odometer" ? (r.perMileCents != null ? `${cents(r.perMileCents, 3)}/mi` : "—") : (r.perHourCents != null ? `${cents(r.perHourCents)}/hr` : "—")}</td>
                <td style={{ textAlign: "right" }}>{money(r.tco.totalCents)}{r.tco.totalCents > 0 && <div className="muted" style={{ fontSize: 12 }}>{r.meter === "odometer" ? (r.tco.perMileCents != null ? `${cents(r.tco.perMileCents, 3)}/mi` : "") : (r.tco.perHourCents != null ? `${cents(r.tco.perHourCents)}/hr` : "")}</div>}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : report.data ? <Empty>{q ? "No assets match." : "No assets yet."}</Empty> : null}
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        Fuel and maintenance are for the period; &ldquo;Ran&rdquo; is miles (or engine hours) logged in it. Lifetime cost of ownership is the purchase price plus all
        maintenance and fuel, per mile or hour since purchase (add purchase details with Edit on each asset). Economy is flagged when it&apos;s 15% or more below the asset&apos;s usual.
      </p>
    </>
  );
}

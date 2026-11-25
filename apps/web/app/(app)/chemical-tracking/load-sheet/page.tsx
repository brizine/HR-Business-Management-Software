"use client";
import Link from "next/link";
import { useState } from "react";
import { formatRateAmount } from "@crewdesk/shared";
import { fmtDate } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";

interface Item { productId: string; product: string; unit: string; amount: number; method: string | null; sprayGal: number | null }
interface Stop { visitId: string; number: number; time: string | null; status: string; customer: string; address: string; sqFt: number | null; items: Item[] }
interface Group {
  key: string; label: string; stops: Stop[]; missingSize: number;
  totals: { productId: string; product: string; unit: string; method: string | null; amount: number; stops: number }[];
  spray: { method: string; gal: number }[];
}

const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const gal = (g: number) => `${g.toLocaleString("en-US", { maximumFractionDigits: 1 })} gal`;
const amt = (a: number, unit: string) => formatRateAmount(Math.round(a * 100) / 100, unit);
const time12 = (t: string | null) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };

/**
 * What each tech or truck loads for a day: concentrate per product, spray to mix per method, and
 * the stops. Planned from each service's products and the lawn sizes; printable for the morning.
 */
export default function LoadSheet() {
  const [date, setDate] = useState(today());
  const [by, setBy] = useState<"tech" | "truck">("tech");
  const data = useApi<{ groups: Group[] }>(`/chemical-tracking/load-sheet?date=${date}&by=${by}`);
  const groups = data.data?.groups ?? [];
  return (
    <>
      <PageHead title="Load sheet" sub="What to load for the day's chemical work orders, planned from each service's products and the lawn sizes. Actual amounts go on the records.">
        <button className="btn noprint" onClick={() => window.print()} disabled={!groups.length}>Print</button>
      </PageHead>
      <div className="row noprint" style={{ marginBottom: 12, alignItems: "flex-end" }}>
        <label style={{ width: 180 }}>Day<input type="date" value={date} onChange={(e) => setDate(e.target.value || today())} /></label>
        <div className="row" role="group" aria-label="Group by" style={{ gap: 6 }}>
          <button className={`btn ${by === "tech" ? "primary" : ""}`} onClick={() => setBy("tech")}>By tech</button>
          <button className={`btn ${by === "truck" ? "primary" : ""}`} onClick={() => setBy("truck")}>By truck</button>
        </div>
      </div>
      <p className="printonly" style={{ margin: "0 0 8px" }}><strong>{fmtDate(date)}</strong> · by {by}</p>
      <ErrorBox error={data.error} />
      {groups.length ? groups.map((g) => (
        <section key={g.key} className="card stack loadsheet-group" style={{ marginBottom: 16, breakInside: "avoid" }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <h2 style={{ margin: 0 }}>{g.label}</h2>
            <span className="muted">{g.stops.length} stop{g.stops.length === 1 ? "" : "s"}{g.missingSize ? <> · <span className="badge warn">{g.missingSize} without a lawn size</span></> : null}</span>
          </div>
          {g.spray.length > 0 && (
            <p style={{ margin: 0 }}><strong>Spray to mix:</strong> {g.spray.map((s) => `${gal(s.gal)} (${s.method})`).join(" · ")}</p>
          )}
          <div className="tablewrap">
            <table>
              <thead><tr><th>Product</th><th>Applied with</th><th>Load</th><th>Stops</th></tr></thead>
              <tbody>{g.totals.map((t) => (
                <tr key={`${t.productId}-${t.method}-${t.unit}`}><td><strong>{t.product}</strong></td><td>{t.method ?? "—"}</td><td>{amt(t.amount, t.unit)}</td><td>{t.stops}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <details open>
            <summary className="noprint">Stops</summary>
            <div className="tablewrap">
              <table>
                <thead><tr><th>Stop</th><th>Lawn</th><th>Products</th></tr></thead>
                <tbody>{g.stops.map((s) => (
                  <tr key={s.visitId}>
                    <td><Link href={`/visits/${s.visitId}`}><strong>{s.customer}</strong></Link><div className="muted">{s.address}{s.time ? ` · ${time12(s.time)}` : ""} · WO-{s.number}{s.status === "completed" ? " · done" : ""}</div></td>
                    <td>{s.sqFt ? `${s.sqFt.toLocaleString()} sq ft` : <span className="badge warn">no size</span>}</td>
                    <td>{s.items.map((i) => <div key={`${i.productId}-${i.method}`}>{i.product} <span className="muted">{s.sqFt ? amt(i.amount, i.unit) : "—"}{i.sprayGal != null ? ` in ${gal(i.sprayGal)}` : ""}</span></div>)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </details>
        </section>
      )) : data.loading ? <Empty>Loading…</Empty> : <Empty>No chemical work orders on {fmtDate(date)}.</Empty>}
    </>
  );
}

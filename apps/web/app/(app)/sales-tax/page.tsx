"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { formatMoney, formatTaxRate } from "@crewdesk/shared";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/hooks";
import { Empty, ErrorBox, PageHead } from "@/components/ui";
import { Icon } from "@/components/icons";

type Rate = { rate: number; taxableCents: number; taxCents: number };
type Period = { period: string; invoices: number; salesCents: number; taxableCents: number; untaxedCents: number; exemptCents: number; taxCents: number; rates: Rate[] };
type Report = { from: string; to: string; by: "month" | "quarter"; taxEnabled: boolean; taxName: string; periods: Period[]; total: Period };

const label = (p: string) => (/^\d{4}-\d{2}$/.test(p) ? new Date(`${p}-15T12:00:00`).toLocaleDateString([], { month: "long", year: "numeric" }) : p);
const yearStart = () => `${new Date().getFullYear()}-01-01`;
const todayIso = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); };
/** Spreadsheet-safe CSV cell. */
const cell = (v: string | number) => { const s = String(v); const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
const dollars = (c: number) => (c / 100).toFixed(2);

/**
 * The sales tax report, for filing: invoices dated in the range (sent, not void), by month or quarter:
 * sales after discounts, the taxable and untaxed parts (and the untaxed sales to tax-exempt
 * customers), the tax by rate, and the tax charged. Print it or export it to a spreadsheet.
 */
export default function SalesTax() {
  const { can } = useAuth();
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(todayIso());
  const [by, setBy] = useState<"month" | "quarter">("month");
  const report = useApi<Report>(from && to ? `/invoices/tax-report?from=${from}&to=${to}&by=${by}` : null);
  const r = report.data;
  const rows = useMemo(() => (r ? [...r.periods, r.total] : []), [r]);
  const csv = () => {
    if (!r) return;
    const head = ["Period", "Invoices", "Sales", "Taxable", "Untaxed", "Untaxed (exempt customers)", `${r.taxName}`, "By rate"];
    const lines = rows.map((p) => [label(p.period), p.invoices, dollars(p.salesCents), dollars(p.taxableCents), dollars(p.untaxedCents), dollars(p.exemptCents), dollars(p.taxCents),
      p.rates.map((x) => `${formatTaxRate(x.rate)}: ${dollars(x.taxableCents)} taxable, ${dollars(x.taxCents)} tax`).join("; ")]);
    const blob = new Blob([[head, ...lines].map((l) => l.map(cell).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `sales-tax-${r.from}-to-${r.to}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <>
      <PageHead title="Sales tax report" before={<Link className="btn no-print" href="/invoices" aria-label="Back to invoices">←</Link>}
        sub="Invoices sent in the dates, by when they're dated. Drafts and void invoices stay out.">
        <button className="btn no-print" onClick={() => window.print()}><Icon name="print" size={14} /> Print</button>
        <button className="btn no-print" disabled={!r} onClick={csv}><Icon name="download" size={14} /> Export CSV</button>
      </PageHead>
      {r && !r.taxEnabled && (
        <div className="notice no-print">Sales tax is off, so no invoice has tax yet.{can("admin", "customers") ? <> Turn it on in <Link href="/settings/customers">Settings → Customers &amp; billing</Link>.</> : ""}</div>
      )}
      <div className="card filters no-print">
        <label>From<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        <label>By
          <select value={by} onChange={(e) => setBy(e.target.value as "month" | "quarter")}><option value="month">Month</option><option value="quarter">Quarter</option></select>
        </label>
      </div>
      <ErrorBox error={report.error} />
      {r && !r.periods.length ? <div className="card"><Empty>No sent invoices in those dates.</Empty></div> : r && (
        <div className="card tablewrap">
          <table className="tax-report">
            <thead>
              <tr><th>{by === "month" ? "Month" : "Quarter"}</th><th className="num">Invoices</th><th className="num">Sales</th><th className="num">Taxable</th><th className="num">Untaxed</th><th className="num">Untaxed, exempt customers</th><th className="num">{r.taxName}</th></tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.period} className={p.period === "Total" ? "total" : undefined}>
                  <td>
                    {p.period === "Total" ? <strong>Total</strong> : label(p.period)}
                    {p.rates.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{p.rates.map((x) => `${formatTaxRate(x.rate)} on ${formatMoney(x.taxableCents)} = ${formatMoney(x.taxCents)}`).join(" · ")}</div>}
                  </td>
                  <td className="num">{p.invoices}</td>
                  <td className="num">{formatMoney(p.salesCents)}</td>
                  <td className="num">{formatMoney(p.taxableCents)}</td>
                  <td className="num">{formatMoney(p.untaxedCents)}</td>
                  <td className="num">{formatMoney(p.exemptCents)}</td>
                  <td className="num"><strong>{formatMoney(p.taxCents)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>Sales are after discounts. Tax is charged on what&apos;s paid after a discount, spread across the lines.</p>
        </div>
      )}
    </>
  );
}
